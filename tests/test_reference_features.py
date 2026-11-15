import asyncio
import json
from dataclasses import replace
from datetime import datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from doubao_work2api.accounts import Account, AccountPool
from doubao_work2api.affinity import AccountAffinity
from doubao_work2api.app import create_app
from doubao_work2api.benefits import BenefitsService, CHINA, today
from doubao_work2api.catalog import DEFAULT_MODEL_ID
from doubao_work2api.config import Settings
from doubao_work2api.errors import UpstreamError
from doubao_work2api.live_catalog import LiveCatalog, parse_models
from doubao_work2api.models import ChatCompletionRequest, ChatMessage
from doubao_work2api.protocol import upstream_payload
from doubao_work2api.qr_login import QRLogin, qr_status, trusted_url, web_context
from doubao_work2api.service import ChatService
from doubao_work2api.sse import keepalive
from doubao_work2api.transport import DirectTransport
from doubao_work2api.upstream_admin import quota_windows, daily_candidates, metadata_request


@pytest.fixture(autouse=True)
def immediate_confirmation(monkeypatch):
    monkeypatch.setattr('doubao_work2api.benefits.CONFIRM_DELAYS', (0,))


def settings(tmp_path):
    return Settings(data_dir=tmp_path/'data', accounts_dir=tmp_path/'accounts', api_key='test-key', admin_password='test-password')


async def pool(tmp_path):
    result = AccountPool(tmp_path/'accounts')
    await result.upsert({'id':'one','cookies':{'sessionid':'fake-one'},'device_id':'device','web_id':'web'})
    return result


def test_quota_windows_are_not_added_or_guessed():
    view = quota_windows({'data': {'window_limit_groups': [{'feature_group_name':'订阅', 'window_limits':[
        {'window_type':1,'total_amount':'100','used_amount':'20'},
        {'window_type':2,'total_amount':'300','used_amount':'30'},
        {'window_type':4,'used_percent':'40'},
    ]}]}})
    assert [row['remaining'] for row in view['windows']] == [80,270,None]
    assert 'total' not in view and view['request_credits'] is None
    assert quota_windows({'data': {'window_limits':[{'total_amount':'NaN','used_amount':True}]}})['windows'][0]['total'] is None


def task_payload(checked=False):
    return {'data': {'campaign_group': {'campaign_group_code':'daily', 'tasks':[
        {'campaign_code':'daily-task','daily_checkin':{'checked_in_today':checked},'task_status':2,'task_id':'real-task'},
        {'campaign_code':'other-task','task_status':2,'task_id':'do-not-claim'},
    ]}}}


def test_only_explicit_daily_tasks_are_claimable():
    found = daily_candidates(task_payload(), 'daily')
    assert len(found) == 1 and found[0]['claim'] == {'task_id':'real-task'}


async def test_pending_claim_is_never_resubmitted_after_restart(tmp_path, monkeypatch):
    accounts = await pool(tmp_path)
    calls = []

    async def request(transport, account, route, body=None):
        calls.append(route)
        if route == 'launch':
            return {'data':{'ug_campaign_info':{'campaign_group_code':'daily'}}}
        if route == 'checkin':
            raise UpstreamError('connection lost after write')
        return task_payload(False)

    monkeypatch.setattr('doubao_work2api.benefits.metadata_request', request)
    service = BenefitsService(accounts, object(), tmp_path)
    assert (await service.checkin('one'))['status'] == 'pending'
    restarted = BenefitsService(accounts, object(), tmp_path)
    assert (await restarted.checkin('one'))['status'] == 'pending'
    assert calls.count('checkin') == 1


async def test_claim_requires_durable_reservation_and_official_confirmation(tmp_path, monkeypatch):
    accounts = await pool(tmp_path)
    calls = []

    async def request(transport, account, route, body=None):
        calls.append(route)
        if route == 'launch':
            return {'data':{'ug_campaign_info':{'campaign_group_code':'daily'}}}
        if route == 'checkin':
            saved = json.loads((tmp_path/'benefits.json').read_text())
            assert saved['accounts']['one']['claim']['day'] == today()
            assert saved['accounts']['one']['claim']['endpoint'] == 'landing_checkin'
            assert body == {'scene':'daily', 'biz_params':{}}
            return {'code':0, 'data':{'checked_in':True}}
        return task_payload('checkin' in calls)

    monkeypatch.setattr('doubao_work2api.benefits.metadata_request', request)
    service = BenefitsService(accounts, object(), tmp_path)
    assert (await service.checkin('one'))['status'] == 'claimed'
    assert (await service.checkin('one'))['status'] == 'claimed'
    assert calls.count('checkin') == 1


async def test_old_generic_reward_pending_migrates_once_to_daily_endpoint(tmp_path, monkeypatch):
    accounts = await pool(tmp_path)
    service = BenefitsService(accounts, object(), tmp_path)
    service._record('one', claim={'day':today(),'group':'daily','code':'daily-task','submitted_at':1})
    calls = []

    async def request(transport, account, route, body=None):
        calls.append(route)
        if route == 'launch':
            return {'data':{'ug_campaign_info':{'campaign_group_code':'daily'}}}
        if route == 'checkin':
            assert body == {'scene':'daily','biz_params':{}}
            return {'code':0,'data':{'checked_in':True}}
        return task_payload('checkin' in calls)

    monkeypatch.setattr('doubao_work2api.benefits.metadata_request', request)
    assert (await service.checkin('one'))['status'] == 'claimed'
    assert (await service.checkin('one'))['status'] == 'claimed'
    assert calls.count('checkin') == 1 and 'claim' not in calls
    ledger = service.state['accounts']['one']['claim']
    assert ledger['previous_endpoint'] == 'item_reward' and ledger['previous_attempt']['submitted_at'] == 1


async def test_sdk_error_falls_back_to_item_reward_and_does_not_resubmit(tmp_path, monkeypatch):
    """官方 landing/checkin 恒报 710010702 时，自动降级到 item reward 领取。"""
    accounts = await pool(tmp_path)
    calls = []

    async def request(transport, account, route, body=None):
        calls.append(route)
        if route == 'launch':
            return {'data':{'ug_campaign_info':{'campaign_group_code':'daily'}}}
        if route == 'checkin':
            raise UpstreamError('redacted upstream error',code='710010702')
        return task_payload(False)

    monkeypatch.setattr('doubao_work2api.benefits.metadata_request', request)
    service = BenefitsService(accounts, object(), tmp_path)
    first = await service.checkin('one')
    second = await BenefitsService(accounts, object(), tmp_path).checkin('one')
    assert first['status'] == second['status'] == 'pending'
    assert first['query_only'] is True
    assert calls.count('checkin') == 1 and calls.count('claim') == 1
    assert service.state['accounts']['one']['claim'].get('fallback') == 'item_reward'


async def test_definitely_unsent_checkin_can_be_retried(tmp_path, monkeypatch):
    accounts = await pool(tmp_path)
    calls = []

    async def request(transport, account, route, body=None):
        calls.append(route)
        if route == 'launch':
            return {'data':{'ug_campaign_info':{'campaign_group_code':'daily'}}}
        if route == 'checkin':
            if calls.count('checkin') == 1:
                raise UpstreamError('connect failed',code='metadata_not_sent')
            return {'code':0,'data':{'checked_in':True}}
        return task_payload(calls.count('checkin') >= 2)

    monkeypatch.setattr('doubao_work2api.benefits.metadata_request', request)
    service = BenefitsService(accounts, object(), tmp_path)
    assert (await service.checkin('one'))['status'] == 'error'
    assert service.state['accounts']['one']['claim']['outcome'] == 'not_sent'
    assert (await service.checkin('one'))['status'] == 'claimed'
    assert calls.count('checkin') == 2


@pytest.mark.parametrize(('error_type', 'code'), [
    (httpx.ConnectError, 'metadata_not_sent'),
    (httpx.ConnectTimeout, 'metadata_not_sent'),
    (httpx.PoolTimeout, 'metadata_not_sent'),
    (httpx.WriteTimeout, 'metadata_network_error'),
    (httpx.ReadTimeout, 'metadata_network_error'),
])
async def test_checkin_metadata_separates_unsent_from_uncertain(tmp_path, monkeypatch, error_type, code):
    accounts = await pool(tmp_path)
    transport = DirectTransport(settings(tmp_path))

    def handler(request):
        assert request.url.path == '/alice/ug/campaign/landing/checkin'
        assert json.loads(request.content) == {'scene':'daily','biz_params':{}}
        raise error_type('synthetic network failure', request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        async def client_for(account):
            return client
        monkeypatch.setattr(transport, '_client_for', client_for)
        with pytest.raises(UpstreamError) as raised:
            await metadata_request(transport, accounts.find('one'), 'checkin', {'scene':'daily','biz_params':{}})
        assert raised.value.code == code


async def test_success_receipt_waits_for_matching_official_detail(tmp_path, monkeypatch):
    accounts = await pool(tmp_path)
    reads = []
    claimed = []

    async def request(transport, account, route, body=None):
        if route == 'launch':
            return {'data':{'ug_campaign_info':{'campaign_group_code':'daily'}}}
        if route == 'checkin':
            claimed.append(True)
            return {'code':0,'data':{'checked_in':True}}
        if route in ('quota','overview'):
            return {'data':{}}
        reads.append(True)
        return task_payload(len(reads) >= 4)

    monkeypatch.setattr('doubao_work2api.benefits.metadata_request', request)
    monkeypatch.setattr('doubao_work2api.benefits.CONFIRM_DELAYS', (0,0,0))
    result = await BenefitsService(accounts, object(), tmp_path).checkin('one')
    assert result['status'] == 'claimed' and len(reads) == 4 and len(claimed) == 1


async def test_scheduler_disabled_by_default_and_runs_once_per_day(tmp_path, monkeypatch):
    accounts = await pool(tmp_path)
    service = BenefitsService(accounts, object(), tmp_path)
    called = []

    async def checkin(account_id):
        called.append(account_id)

    monkeypatch.setattr(service, 'checkin', checkin)
    await service.due_once()
    assert not called
    service.configure({'enabled':True,'hour':0,'minute':0,'account_ids':['one']})
    await service.due_once()
    await service.due_once()
    assert called == ['one']
    with pytest.raises(ValueError):
        service.configure({'enabled':'false'})
    with pytest.raises(ValueError):
        service.configure({'account_ids':['deleted']})


def catalog_payload():
    return {'data': {'entry_list':[{'active_switch_conf':{'menu_conf_v2': {'model_list':{'item_list':[
        {'name':'新模型','model_item_key':'new-native-model','agent_mode':1,'conversation_mode_list':['office','creation'],
         'model_extra_params': {'memory_profile':'256k','total_window_size':'256000'},
         'tag_list':[{'text':'限时 0.02x'}],
         'reasoning_effort_config':{'default_level':4,'option_list':[{'level':3},{'level':4}]}},
        {'model_item_key':'9'},
        {'name':'仅普通聊天','model_item_key':'chat-only','conversation_mode_list':['2']},
    ]}}}}]}}


def test_catalog_uses_official_names_price_effort_and_skips_default_selectors():
    specs = parse_models(catalog_payload())
    assert len(specs) == 1
    spec = specs[0]
    assert spec.id == 'new-native-model' and spec.name == '新模型'
    assert spec.price == '限时 0.02x' and spec.context_window == 256000
    assert spec.reasoning_levels == ('low','medium') and spec.default_reasoning_effort == 'medium'
    assert spec.image_input is None


def test_catalog_uses_only_active_menu_and_excludes_membership_gated_dispatch():
    payload = catalog_payload()
    config = payload['data']['entry_list'][0]['active_switch_conf']
    config['use_menu_conf_v2'] = True
    config['menu_conf'] = {'item_list':[{'name':'Old catalog','model_item_key':'old-model'}]}
    gated = dict(config['menu_conf_v2']['model_list']['item_list'][0])
    gated.update(model_item_key='paid-model', subscribe_config={'need_upgrade':True})
    config['menu_conf_v2']['model_list']['item_list'].append(gated)
    assert {row.id for row in parse_models(payload)} == {'new-native-model','paid-model'}
    assert {row.id for row in parse_models(payload, only_available=True)} == {'new-native-model'}


async def test_discovered_model_is_callable_cached_and_isolated_between_apps(tmp_path, monkeypatch):
    accounts = await pool(tmp_path)

    async def request(transport, account, route, body=None):
        return {'data':{'assistant_bot_id':'native-bot'}} if route == 'launch' else catalog_payload()

    monkeypatch.setattr('doubao_work2api.live_catalog.metadata_request', request)
    catalog = LiveCatalog(tmp_path)
    await catalog.refresh(object(), accounts.find('one'))
    request = catalog.bind(ChatCompletionRequest(model='new-native-model',messages=[ChatMessage(role='user',content='hello')]))
    payload = upstream_payload(request, model_key='new-native-model', workspace=tmp_path,
                               app_id='test', device_id='device', device_name='test')
    assert payload['option']['model_config']['reasoning_effort'] == 4
    assert LiveCatalog(tmp_path).find('new-native-model').name == '新模型'
    assert LiveCatalog(tmp_path/'other').find('new-native-model') is None
    assert catalog.eligible_ids('new-native-model') == {'one'}


async def test_affinity_preserves_key_scopes_and_account_permissions(tmp_path):
    accounts = await pool(tmp_path)
    await accounts.upsert({'id':'two','cookies':{'sessionid':'fake-two'}})
    used = []

    class Transport:
        async def stream(self, account, payload):
            used.append(account.id)
            yield {'_event':'CHUNK_DELTA','text':'OK'}

    service = ChatService(accounts, Transport(), model_key='unused', app_id='test', workspace_root=tmp_path)
    def request():
        return ChatCompletionRequest(messages=[ChatMessage(role='user',content='hi')], session_id='same-session')
    await service.complete(request(), key_id='key-a')
    await service.complete(request(), key_id='key-a')
    await service.complete(request(), key_id='key-b')
    await service.complete(request(), key_id='key-a', allowed_ids={'two'})
    assert used == ['one','one','two','two']


def test_affinity_cache_is_bounded_and_expires():
    cache = AccountAffinity(ttl=-1, limit=2)
    cache.bind('old','one')
    assert cache.get('old') is None
    cache.bind('a','one'); cache.bind('b','two'); cache.bind('c','three')
    assert len(cache.entries) == 2 and 'a' not in cache.entries


async def test_keepalive_does_not_cancel_or_duplicate_pending_chunks():
    ready = asyncio.Event()
    closed = asyncio.Event()

    async def stream():
        try:
            await ready.wait()
            yield 'data: body\n\n'
        finally:
            closed.set()

    output = keepalive(stream(), interval=0.001)
    assert await anext(output) == ': ping\n\n'
    ready.set()
    assert await anext(output) == 'data: body\n\n'
    assert [item async for item in output] == []
    assert closed.is_set()


async def test_keepalive_cancellation_releases_source():
    closed = asyncio.Event()

    async def stream():
        try:
            await asyncio.Event().wait()
            yield 'unreachable'
        finally:
            closed.set()

    output = keepalive(stream(), interval=0.001)
    await anext(output)
    await output.aclose()
    assert closed.is_set()


def test_web_context_and_redirect_allowlist():
    router = {'loaderData':{'chat_layout':{'chat_layout':{'launchCore':{'web_id':'1234567890123456789'},'aid':'582478','pc_version':'2.0'}}}}
    context = web_context('<script>window._ROUTER_DATA = '+json.dumps(router)+';</script>')
    assert context['device_id'] == '1234567890123456789' and context['client_profile'] == 'web'
    assert trusted_url('https://accounts.doubao.com/sso')
    for url in ('http://www.doubao.com/', 'https://doubao.com.evil.test/', 'https://doubao.com:8443/', 'https://user@www.doubao.com/'):
        assert not trusted_url(url)
    assert qr_status('6') == 'confirmed' and qr_status('scanning') == 'scanned'


async def test_qr_login_is_owner_scoped_and_saves_verified_official_context(tmp_path):
    import base64
    accounts = AccountPool(tmp_path/'accounts')
    requests = []
    router = {'loaderData':{'chat_layout':{'chat_layout':{'launchCore':{'web_id':'987654321'},'aid':'582478','pc_version':'2.0'}}}}

    def handler(request):
        requests.append(request)
        path = request.url.path
        if path.endswith('get_qrcode/'):
            return httpx.Response(200,json={'data':{'token':'secret-qr-token','qrcode':'data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\nsynthetic').decode()}})
        if path.endswith('check_qrconnect/'):
            return httpx.Response(200,json={'data':{'status':'confirmed','redirect_url':'/passport/sso/first'}})
        if path == '/passport/sso/first':
            return httpx.Response(302,headers={'location':'https://www.doubao.com/passport/sso/final'})
        if path == '/passport/sso/final':
            return httpx.Response(302,headers={'location':'/chat/','set-cookie':'sessionid=verified-session; Domain=.doubao.com; Path=/'})
        if 'account/info' in path:
            return httpx.Response(200,json={'data':{'user_id_str':'1234567890123456789','name':'Test account'}})
        return httpx.Response(200,text='<script>window._ROUTER_DATA='+json.dumps(router)+';</script>')

    qr = QRLogin(accounts, lambda:httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    try:
        start = await qr.start('owner-one')
        assert 'secret-qr-token' not in json.dumps(start)
        with pytest.raises(KeyError):
            await qr.poll(start['id'], 'owner-two')
        confirmed = await qr.poll(start['id'], 'owner-one')
        assert confirmed['status'] == 'confirmed'
        saved = accounts.accounts[0]
        assert saved.cookies['sessionid'] == 'verified-session'
        assert saved.app_id == '582478' and saved.device_id == '987654321'
        assert len(accounts.accounts) == 1
        again = await qr.poll(start['id'], 'owner-one')
        assert again['account_id'] == confirmed['account_id']
    finally:
        await qr.close()


def test_new_admin_routes_require_admin_session_not_api_key(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        for path in ('/admin/benefits','/admin/accounts'):
            assert client.get(path,headers={'Authorization':'Bearer test-key'}).status_code == 401
        assert client.post('/admin/accounts/qr').status_code == 401
        assert client.post('/admin/login',json={'password':'test-password'}).status_code == 200
        assert client.get('/admin/benefits').json()['config']['enabled'] is False
        assert client.put('/admin/automation/config',headers={'Origin':'https://evil.test'},json={'enabled':True}).status_code == 403
        assert client.put('/admin/automation/config',json={'enabled':True,'hour':0,'minute':15,'account_ids':[]}).status_code == 200
        assert client.post('/admin/checkin').json() == {'results':[]}


def test_discovered_model_is_callable_through_authenticated_api(tmp_path, monkeypatch):
    async def request(transport, account, route, body=None):
        return {'data':{}} if route == 'launch' else catalog_payload()

    monkeypatch.setattr('doubao_work2api.live_catalog.metadata_request', request)
    app = create_app(settings(tmp_path))
    sent = []

    class Transport:
        async def stream(self, account, payload):
            sent.append((account.id,payload['option']['model_config']))
            yield {'_event':'CHUNK_DELTA','text':'NEW_MODEL_OK'}

    app.state.service.transport = Transport()
    with TestClient(app) as client:
        client.post('/admin/login',json={'password':'test-password'})
        client.post('/admin/accounts/import',json={'account':{'id':'one','cookies':{'sessionid':'fake-one'}}})
        client.post('/admin/accounts/import',json={'account':{'id':'two','cookies':{'sessionid':'fake-two'}}})
        assert client.post('/admin/catalog/refresh',json={'account_id':'one'}).status_code == 200
        key = client.post('/admin/keys',json={'name':'dynamic','models':['new-native-model']}).json()['key']
        headers = {'Authorization':'Bearer '+key}
        assert [model['id'] for model in client.get('/v1/models',headers=headers).json()['data']] == ['new-native-model']
        response = client.post('/v1/chat/completions',headers=headers,json={'model':'new-native-model','messages':[{'role':'user','content':'hi'}]})
        assert response.status_code == 200
        assert response.json()['choices'][0]['message']['content'] == 'NEW_MODEL_OK'
        assert sent[0][0] == 'one' and sent[0][1]['model_item_key'] == 'new-native-model'
        assert sent[0][1]['reasoning_effort'] == 4


async def test_qr_poll_forwards_csrf_cookie_as_header(tmp_path):
    """官方 passport 要求把 csrf cookie 回填到请求头，否则一律 2035 非法请求。"""
    import base64

    accounts = AccountPool(tmp_path/'accounts')
    seen = []
    png = base64.b64encode(b'\x89PNG\r\n\x1a\nsynthetic').decode()

    def handler(request):
        path = request.url.path
        if path.endswith('get_qrcode/'):
            return httpx.Response(
                200, json={'data': {'token': 'tok', 'qrcode': 'data:image/png;base64,' + png}},
                headers={'set-cookie': 'passport_csrf_token=csrf-value; Domain=.doubao.com; Path=/'})
        if path.endswith('check_qrconnect/'):
            seen.append(request.headers.get('x-tt-passport-csrf-token'))
            return httpx.Response(200, json={'data': {'status': 'new', 'error_code': 0}})
        return httpx.Response(200, text='<html></html>')

    qr = QRLogin(accounts, lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    try:
        start = await qr.start('owner-csrf')
        state = await qr.poll(start['id'], 'owner-csrf')
        assert state['status'] == 'waiting'
        assert seen and seen[0] == 'csrf-value'
    finally:
        await qr.close()


async def test_qr_poll_refreshes_expired_code_without_failing(tmp_path):
    """二维码过期时自动换新码（官方只有约 60 秒有效期）。"""
    import base64

    accounts = AccountPool(tmp_path/'accounts')
    png = base64.b64encode(b'\x89PNG\r\n\x1a\nsynthetic').decode()
    codes = iter(['tok-old', 'tok-new'])

    def handler(request):
        path = request.url.path
        if path.endswith('get_qrcode/'):
            return httpx.Response(
                200, json={'data': {'token': next(codes, 'tok-new'),
                                    'qrcode': 'data:image/png;base64,' + png}})
        if path.endswith('check_qrconnect/'):
            return httpx.Response(200, json={'data': {'status': 'expired', 'error_code': 0}})
        return httpx.Response(200, text='<html></html>')

    qr = QRLogin(accounts, lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    try:
        start = await qr.start('owner-refresh')
        state = await qr.poll(start['id'], 'owner-refresh')
        assert state['status'] == 'waiting'
        assert state['image'].startswith('data:image/png;base64,')
        assert qr._session(start['id'], 'owner-refresh').token == 'tok-new'
    finally:
        await qr.close()
