"""Isolated passport QR sessions, using only official Doubao origins.

Passport endpoint/query and QR status mapping adapted from yyydsz/doubao2api
(MIT). See licenses/yyydsz-doubao2api-LICENSE.txt and THIRD_PARTY_NOTICES.md.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
import secrets
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit, urljoin

import httpx

from .errors import UpstreamError
from .transport import USER_AGENT

PASSPORT = 'https://accounts.doubao.com/passport/web/'
# 与官方网页版（www.doubao.com）实际抓包完全一致；aid/next 必须配套，
# 否则扫码确认后 check_qrconnect 会返回 2156「服务繁忙」。
QR_PARAMS = {'aid': '497858', 'language': 'zh', 'next': 'https://www.doubao.com',
             'is_from_ttaccountsdk': '1', 'passport_jssdk_version': '4.4.6',
             'passport_jssdk_type': 'normal', 'account_app_language': 'zh-CN',
             'multi_login': '1', 'account_sdk_source': 'web',
             'device_platform': 'web', 'os_type': '1', 'terminal_type': '2'}


def qr_params(extra=None) -> dict:
    """Official passport params; ``ts`` must be refreshed on every call."""
    params = dict(QR_PARAMS)
    params['ts'] = str(int(time.time()))
    if extra:
        params.update(extra)
    return params


def trusted_url(url: str) -> bool:
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ''
        return (parsed.scheme == 'https' and (host == 'doubao.com' or host.endswith('.doubao.com'))
                and parsed.port in (None, 443) and not parsed.username and not parsed.password)
    except ValueError:
        return False


def qr_status(value) -> str:
    word = str(value).strip().lower()
    for status, words in {
        'waiting': ('new', '0', '1', 'waiting'), 'scanned': ('scanning', 'scanned', '2', '5'),
        'confirmed': ('confirmed', 'success', '3', '6'), 'expired': ('expired', '4', '7'),
        'canceled': ('canceled', 'cancelled', '8'),
    }.items():
        if word in words:
            return status
    return 'waiting'


def qr_image(data: dict) -> str:
    raw = data.get('base64_image') or data.get('qrcode') or ''
    if isinstance(raw, str):
        encoded = raw.removeprefix('data:image/png;base64,')
        try:
            binary = base64.b64decode(encoded, validate=True)
            if len(binary) <= 512000 and binary.startswith(b'\x89PNG\r\n\x1a\n'):
                return 'data:image/png;base64,' + encoded
        except (ValueError, TypeError):
            pass
    url = data.get('qrcode_index_url')
    if isinstance(url, str) and len(url) < 8192 and trusted_url(url):
        import qrcode
        from qrcode.image.svg import SvgPathImage
        image = qrcode.make(url, image_factory=SvgPathImage)
        return 'data:image/svg+xml;base64,' + base64.b64encode(image.to_string()).decode('ascii')
    raise UpstreamError('官方未返回可显示的二维码。', code='qr_image_missing')


def web_context(html: str) -> dict:
    match = re.search(r'window\s*\.\s*_ROUTER_DATA\s*=\s*(\{.*?\})\s*;?\s*</script>', html, re.S)
    try:
        data = json.loads(match[1])['loaderData']['chat_layout']['chat_layout']
        web_id = str(data['launchCore']['web_id'])
        app_id, version = str(data['aid']), data['pc_version']
        if not web_id.isdigit() or not app_id.isdigit() or not isinstance(version, str) or not version:
            raise ValueError()
        return {'device_id': web_id, 'web_id': web_id, 'app_id': app_id,
                'client_version': version[:100], 'client_profile': 'web'}
    except (ValueError, KeyError, TypeError):
        raise UpstreamError('官网未返回完整设备上下文，请重新扫码或导入桌面账号。', code='web_context_missing') from None


@dataclass
class QRSession:
    client: httpx.AsyncClient
    expires_at: float
    owner: str
    token: str = ''
    image: str = ''
    status: str = 'waiting'
    account_id: str = ''
    last_poll: float = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def public(self, session_id):
        return {'id': session_id, 'status': self.status, 'image': self.image,
                'expires_at': self.expires_at, 'account_id': self.account_id}


class QRLogin:
    def __init__(self, pool, client_factory=None):
        self.pool = pool
        self.sessions: dict[str, QRSession] = {}
        self.client_factory = client_factory or (lambda: httpx.AsyncClient(
            http2=True, follow_redirects=False, timeout=25,
            headers={'User-Agent': USER_AGENT, 'Referer': 'https://www.doubao.com/',
                     'Origin': 'https://www.doubao.com'}))

    async def _get(self, session, url, params=None, headers=None):
        if not trusted_url(url):
            raise UpstreamError('登录跳转地址无效。', code='qr_invalid_redirect')
        try:
            async with session.client.stream('GET', url, params=params,
                                             headers=headers) as response:
                if not 200 <= response.status_code < 400:
                    raise UpstreamError('官方登录请求失败，请刷新二维码。', code='qr_upstream_error')
                content, size = [], 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > 4 * 1024 * 1024:
                        raise UpstreamError('登录响应过大。', code='qr_upstream_error')
                    content.append(chunk)
                location = response.headers.get('location')
                return b''.join(content), urljoin(str(response.url), location) if location else None
        except httpx.RequestError:
            raise UpstreamError('无法连接豆包登录服务，请稍后重试。', code='qr_network_error') from None

    async def _json(self, session, url, params=None, headers=None):
        raw, _ = await self._get(session, url, params, headers)
        try:
            value = json.loads(raw)
            if isinstance(value, dict):
                return value
        except (ValueError, UnicodeError):
            pass
        raise UpstreamError('官方登录响应格式已变化。', code='qr_upstream_error')

    async def start(self, owner):
        for session_id, session in list(self.sessions.items()):
            if session.expires_at < time.time():
                await self.cancel(session_id, session.owner)
        if len(self.sessions) >= 4:
            raise ValueError('已有多个登录窗口，请先关闭或等待二维码过期。')
        session_id = secrets.token_urlsafe(24)
        session = QRSession(self.client_factory(), time.time()+180, owner)
        self.sessions[session_id] = session
        try:
            # 先像真实网页那样落地设备 Cookie（ttwid / s_v_web_id 等），
            # 否则扫码确认后服务端无法把登录态绑定到本会话。
            try:
                await self._get(session, 'https://www.doubao.com/chat/')
            except UpstreamError:
                pass
            response = await self._json(session, PASSPORT + 'get_qrcode/', qr_params())
            data = response.get('data', {})
            if not isinstance(data, dict) or str(data.get('error_code', '0')) != '0' or not isinstance(data.get('token'), str) or not 0 < len(data['token']) <= 8192:
                raise UpstreamError('官方拒绝生成二维码，请稍后重试。', code='qr_rejected')
            session.token = str(data['token'])
            session.image = qr_image(data)
            return session.public(session_id)
        except BaseException:
            await self.cancel(session_id, owner)
            raise

    def _session(self, session_id, owner):
        session = self.sessions.get(session_id)
        if session is None or session.owner != owner:
            raise KeyError('登录会话不存在。')
        return session

    async def _refresh(self, session) -> bool:
        """官方二维码只有约 60 秒有效期，过期后在同一会话里换一张新的。"""
        try:
            response = await self._json(session, PASSPORT + 'get_qrcode/', qr_params())
            data = response.get('data', {})
            token = str(data.get('token') or '')
            if not token:
                return False
            image = qr_image(data)
        except UpstreamError:
            return False
        session.token, session.image = token, image
        session.last_poll = time.monotonic()
        session.expires_at = time.time() + 150
        return True

    async def poll(self, session_id, owner):
        session = self._session(session_id, owner)
        async with session.lock:
            if session.expires_at <= time.time():
                session.status = 'expired'
                session.token = session.image = ''
                await session.client.aclose()
            if session.status in ('confirmed', 'expired', 'canceled'):
                return session.public(session_id)
            if time.monotonic() - session.last_poll < 2:
                return session.public(session_id)
            session.last_poll = time.monotonic()
            # 官方 passport 现在要求把 csrf cookie 回填到请求头，否则一律
            # 返回 error_code 2035「非法请求」，扫码确认后也永远拿不到状态。
            csrf = session.client.cookies.get('passport_csrf_token', '')
            response = await self._json(
                session, PASSPORT + 'check_qrconnect/',
                qr_params({'token': session.token}),
                {'x-tt-passport-csrf-token': csrf} if csrf else None)
            data = response.get('data', {})
            if not isinstance(data, dict):
                raise UpstreamError('官方登录响应格式已变化。', code='qr_upstream_error')
            # An upstream rejection (e.g. error_code 2035 "非法请求") carries no
            # status field; treating it as "waiting" made the dialog spin forever.
            error_code = str(data.get('error_code', '0') or '0')
            if error_code in ('2156', '2157') and 'status' not in data:
                # 扫码后服务端短暂的「服务繁忙」，保持当前状态继续轮询
                return session.public(session_id)
            if error_code != '0' and 'status' not in data:
                raise UpstreamError(
                    '官方登录接口拒绝了本次查询（%s：%s），扫码登录暂时不可用，请改用浏览器登录或离线扫描。'
                    % (error_code, data.get('description') or '未知错误'),
                    code='qr_upstream_error')
            status = qr_status(data.get('status'))
            if status == 'expired' and await self._refresh(session):
                # 换码成功就继续保持 waiting，前端会自动拿到新的二维码图片
                session.status = 'waiting'
                return session.public(session_id)
            if status == 'confirmed':
                redirect = data.get('redirect_url')
                if redirect:
                    redirect = urljoin(PASSPORT, redirect)
                for _ in range(5):
                    if not redirect:
                        break
                    _, redirect = await self._get(session, redirect)
                # No account is saved until a real identity and official web
                # device context have been obtained from this isolated session.
                user, uid = {}, ''
                for aid in ('582478', '497858'):
                    try:
                        identity = await self._json(
                            session, 'https://www.doubao.com/passport/account/info/v2/',
                            {'aid': aid, 'real_aid': aid, 'account_sdk_source': 'web',
                             'sdk_version': '2.2.5'},
                            {'x-tt-passport-csrf-token': csrf} if csrf else None)
                    except UpstreamError:
                        continue
                    candidate = identity.get('data', {})
                    if not isinstance(candidate, dict):
                        continue
                    value = str(candidate.get('user_id_str') or candidate.get('user_id') or '')
                    if value.isdigit() and int(value) > 0:
                        user, uid = candidate, value
                        break
                if not user:
                    raise UpstreamError('未取得已登录账号身份，请重新扫码。', code='qr_identity_missing')
                html, _ = await self._get(session, 'https://www.doubao.com/chat/')
                context = web_context(html.decode('utf-8', 'replace'))
                cookies = {cookie.name: cookie.value for cookie in session.client.cookies.jar
                           if cookie.domain.lstrip('.') == 'doubao.com' or cookie.domain.endswith('.doubao.com')}
                if not (cookies.get('sessionid') or cookies.get('sessionid_ss')):
                    raise UpstreamError('扫码已确认，但登录凭证尚未就绪，请重试。', code='qr_credentials_missing')
                identity_id = uid + ':' + str(user.get('passport_enterprise_user_type') or '0')
                account = await self.pool.upsert({'id': 'doubao-' + hashlib.sha256(identity_id.encode()).hexdigest()[:24],
                    'identity_id': identity_id, 'cookies': cookies, **context,
                    'name': str(user.get('name') or '扫码账号')[:128], 'user_agent': USER_AGENT,
                    'fingerprint': cookies.get('s_v_web_id', '')})
                session.account_id = account.id
                session.token = ''
                session.image = ''
                await session.client.aclose()
            session.status = status
            return session.public(session_id)

    async def cancel(self, session_id, owner):
        session = self.sessions.get(session_id)
        if session is None or session.owner != owner:
            return
        self.sessions.pop(session_id, None)
        await session.client.aclose()

    async def close(self):
        for session in list(self.sessions.values()):
            await session.client.aclose()
        self.sessions.clear()
