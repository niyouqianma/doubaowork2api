"""Official allowance windows and restart-safe, once-per-day reward claims."""
from __future__ import annotations

import asyncio
import copy
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .accounts import AccountPool
from .errors import GatewayError, UpstreamError
from .private_json import save_private_json
from .upstream_admin import metadata_request, quota_windows, daily_candidates

CHINA = timezone(timedelta(hours=8))
CONFIRM_DELAYS = (0, 2, 4)
CHECKIN_ENDPOINT = 'landing_checkin'


def today() -> str:
    return datetime.now(CHINA).date().isoformat()


class BenefitsService:
    def __init__(self, pool: AccountPool, transport, data_dir: Path):
        self.pool, self.transport = pool, transport
        self.path = data_dir / 'benefits.json'
        self.state = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {
            'config': {'enabled': False, 'hour': 9, 'minute': 0, 'account_ids': []}, 'accounts': {}}
        if not isinstance(self.state.get('accounts'), dict) or not isinstance(self.state.get('config'), dict):
            raise ValueError('Invalid benefits state file')
        self._running: set[str] = set()
        self._task = None

    def _commit(self, state):
        save_private_json(self.path, state)
        self.state = state

    def _record(self, account_id, **changes):
        state = copy.deepcopy(self.state)
        state['accounts'].setdefault(account_id, {}).update(changes)
        self._commit(state)

    def snapshot(self):
        ids = {account.id for account in self.pool.accounts}
        return {'config': copy.deepcopy(self.state['config']),
                'accounts': {key: copy.deepcopy(value) for key, value in self.state['accounts'].items() if key in ids},
                'running': sorted(self._running), 'today': today(), 'timezone': 'Asia/Shanghai'}

    def configure(self, patch):
        if not isinstance(patch, dict) or patch.keys() - {'enabled', 'hour', 'minute', 'account_ids'}:
            raise ValueError('签到设置字段无效。')
        result = {**self.state['config'], **patch}
        if type(result['enabled']) is not bool or type(result['hour']) is not int or not 0 <= result['hour'] <= 23:
            raise ValueError('签到开关或小时无效。')
        if type(result['minute']) is not int or not 0 <= result['minute'] <= 59:
            raise ValueError('签到分钟无效。')
        ids = result['account_ids']
        if not isinstance(ids, list) or len(ids) > 1000 or any(not isinstance(i, str) or self.pool.find(i) is None for i in ids):
            raise ValueError('请选择现有签到账号。')
        result['account_ids'] = list(dict.fromkeys(ids))
        state = copy.deepcopy(self.state)
        state['config'] = result
        self._commit(state)
        return copy.deepcopy(result)

    async def quota(self, account_id):
        account = self.pool.find(account_id)
        if account is None:
            raise KeyError(account_id)
        async with account.lock:
            response = await metadata_request(self.transport, account, 'quota')
            view = quota_windows(response)
            if not view['windows']:
                view = quota_windows(await metadata_request(self.transport, account, 'overview', {'product_line': 'membership'}))
        self._record(account_id, quota=view)
        return view

    async def checkin(self, account_id):
        account = self.pool.find(account_id)
        if account is None:
            raise KeyError(account_id)
        if account_id in self._running:
            return {'status': 'busy', 'message': '此账号正在签到，请稍候。'}
        if not account.available:
            return {'status': 'skipped', 'message': '账号未启用或正在冷却。'}
        self._running.add(account_id)
        try:
            async with account.lock:
                result = await self._checkin(account)
            quota = self.state['accounts'].get(account_id, {}).get('quota', {})
            if result.get('status') in {'done', 'claimed'} and quota.get('updated_at', 0) < result.get('updated_at', 0):
                try:
                    await self.quota(account_id)
                except (GatewayError, KeyError, OSError):
                    pass
            return result
        except GatewayError as exc:
            result = {'day': today(), 'status': 'verification' if exc.code in {'403', '412', '710022004', '710022002', '712010702'} else 'error',
                      'message': '上游要求人工验证，请在豆包官网处理。' if exc.code in {'403', '412', '710022004', '710022002', '712010702'} else '签到查询失败，稍后可重试或回查。',
                      'code': exc.code, 'updated_at': time.time()}
            self._record(account_id, checkin=result)
            return result
        finally:
            self._running.discard(account_id)

    async def _submit_claim(self, account, task, attempt):
        """提交每日签到。

        官方 ``landing/checkin`` 在部分账号上恒返回 710010702「系统错误」
        （真实浏览器点击同样如此），此时自动降级到 item reward 领取接口。
        """
        try:
            return await metadata_request(self.transport, account, 'checkin',
                                          {'scene': task['group'], 'biz_params': {}})
        except GatewayError as exc:
            if str(exc.code) != '710010702':
                raise
            attempt['fallback'] = 'item_reward'
            return await metadata_request(self.transport, account, 'claim',
                                          {'campaign_group_code': task['group'],
                                           'campaign_item_code': task['code']})

    async def _checkin(self, account):
        day = today()
        previous = self.state['accounts'].get(account.id, {}).get('checkin', {})
        if previous.get('day') == day and previous.get('status') in {'done', 'claimed'}:
            return copy.deepcopy(previous)
        launch = await metadata_request(self.transport, account, 'launch')
        group = launch.get('data', {}).get('ug_campaign_info', {}).get('campaign_group_code')
        result = {'day': day, 'updated_at': time.time()}

        def finish(status, message, **more):
            result.update(status=status, message=message, updated_at=time.time(), **more)
            self._record(account.id, checkin=result)
            return result

        if not isinstance(group, str) or not group:
            return finish('inactive', '此账号当前没有每日签到活动。')
        route = 'detail' if group == 'pc_incentive_task_mvp_v3' else 'campaigns'

        async def tasks():
            return daily_candidates(await metadata_request(self.transport, account, route, {'campaign_group_code': group}), group)

        candidates = await tasks()
        if len(candidates) != 1:
            return finish('inactive', '未找到唯一的每日签到任务，未提交领取。')
        task = candidates[0]
        if task['checked']:
            return finish('done', '官方确认今日已签到。')
        # A durable reservation survives a timeout, process crash or lost reply.
        # Never issue a second claim for the same local day after uncertainty.
        ledger = self.state['accounts'].get(account.id, {}).get('claim', {})
        same_task = ledger.get('day') == day and ledger.get('group') == task['group'] and ledger.get('code') == task['code']
        if ledger.get('day') == day and not same_task:
            return finish('pending', '今日领取记录对应的活动已变化，请在官方活动页核对；未提交新的领取。', code='checkin_task_changed')
        if same_task and ledger.get('endpoint') == CHECKIN_ENDPOINT and ledger.get('outcome') != 'not_sent':
            if ledger.get('response_code') == '710010702':
                return finish('manual_required', '官方签到接口返回 710010702「系统错误」，已尝试 item reward 备用路由仍未能确认；官方活动页当前同样报错，属服务端问题，建议稍后重试。',
                              code='710010702', query_only=True)
            if ledger.get('outcome') == 'rejected':
                return finish('error', '官方已拒绝本次签到，请根据错误码处理后在官方活动页核对；本次仅回查。',
                              code=ledger.get('response_code', 'checkin_rejected'), query_only=True)
            return finish('pending', '已尝试官方每日签到，但详情尚未确认；本次仅回查，不重复提交。',
                          code=ledger.get('response_code', 'checkin_unconfirmed'), query_only=True)
        if not task['claim']:
            return finish('ineligible', '今日签到任务尚未满足领取条件。')
        attempt = {'day': day, 'group': task['group'], 'code': task['code'], 'endpoint': CHECKIN_ENDPOINT,
                   'submitted_at': time.time(), 'outcome': 'reserved'}
        if same_task and ledger.get('endpoint') != CHECKIN_ENDPOINT:
            # Old releases sent the generic item reward request. An unchecked
            # daily task is not confirmed by that request. Retain its audit
            # trail and migrate once to the daily endpoint, which is idempotent.
            attempt['previous_attempt'] = {key:ledger[key] for key in ('day','group','code','submitted_at') if key in ledger}
            attempt['previous_endpoint'] = 'item_reward'
        self._record(account.id, claim=attempt)
        receipt_checked = False
        try:
            receipt = await self._submit_claim(account, task, attempt)
            data = receipt.get('data', {})
            receipt_checked = isinstance(data, dict) and data.get('checked_in') is True
            attempt.update(outcome='receipt_checked' if receipt_checked else 'receipt_unconfirmed', response_code='0')
            if isinstance(data, dict):
                attempt['receipt_checked'] = receipt_checked
                attempt['idempotent'] = data.get('idempotent') is True
                # 官方异步发放时会回 biz_error「领取结果确认中」，仅作诊断记录
                biz = data.get('biz_error')
                if isinstance(biz, dict):
                    attempt['biz_code'] = biz.get('code')
                    attempt['biz_message'] = str(biz.get('message') or '')[:120]
        except GatewayError as exc:
            code = str(exc.code)
            outcome = 'not_sent' if code == 'metadata_not_sent' else 'rejected' if (code.isdigit() and (len(code) > 3 or code in {'400','401','403','404','412','422','429'})) else 'uncertain'
            attempt.update(outcome=outcome, response_code=code)
        self._record(account.id, claim=attempt)
        # A failed receipt can still accompany a successful upstream write.
        # Read-only confirmation is always allowed, but never treat code=0 as
        # proof that today's reward was actually granted.
        read_error = None
        for delay in CONFIRM_DELAYS:
            if delay:
                await asyncio.sleep(delay)
            try:
                after = next((row for row in await tasks() if row['group'] == task['group'] and row['code'] == task['code']), None)
            except GatewayError as exc:
                read_error = exc
                break
            if after and after['checked']:
                return finish('claimed', '官方每日签到已完成，并已回查确认。', code='0')
            if attempt['outcome'] in {'not_sent','rejected'}:
                break
        code = attempt.get('response_code', 'checkin_unconfirmed')
        if code == '710010702':
            return finish('manual_required', '官方签到接口返回 710010702「系统错误」，item reward 备用路由未能确认签到；官方活动页当前同样报错，与本地参数无关，请稍后重试。',
                          code=code, query_only=True)
        if code in {'403','412','710022004','710022002','712010702'}:
            return finish('verification', '官方要求人工验证，请先在豆包官网处理后回查签到状态。', code=code, query_only=True)
        if attempt['outcome'] == 'not_sent':
            return finish('error', '连接建立失败，本次签到请求未发送；网络恢复后可重试。', code=code)
        if attempt['outcome'] == 'rejected':
            return finish('error', '官方拒绝签到请求，未确认领取成功，请根据错误码处理。', code=code, query_only=True)
        if read_error is not None:
            return finish('pending', '签到已尝试，但官方状态回查失败；请稍后回查，不重复提交。', code=str(read_error.code), query_only=True)
        return finish('pending', '签到回执已确认，官方详情尚未更新；请稍后回查。' if receipt_checked else '官方回执和详情均未确认签到；请稍后回查。',
                      code=code if code != '0' else 'checkin_unconfirmed', query_only=True)

    async def due_once(self, now=None):
        now = now or datetime.now(CHINA)
        config = self.state['config']
        if not config['enabled'] or (now.hour, now.minute) < (config['hour'], config['minute']):
            return
        selected = set(config['account_ids'])
        for account in self.pool.accounts:
            if selected and account.id not in selected:
                continue
            entry = self.state['accounts'].get(account.id, {})
            if not account.available or entry.get('scheduled_day') == today() or entry.get('checkin', {}).get('status') == 'verification':
                continue
            # Reserve the daily scheduler run as well: errors must not spin.
            self._record(account.id, scheduled_day=today())
            await self.checkin(account.id)

    async def _loop(self):
        while True:
            try:
                await self.due_once()
            except (GatewayError, ValueError, OSError):
                pass
            await asyncio.sleep(30)

    def start(self):
        self._task = asyncio.create_task(self._loop())

    async def close(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
