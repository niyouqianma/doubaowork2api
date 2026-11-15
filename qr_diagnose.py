"""扫码登录链路自检脚本。

用途：确认官方 get_qrcode / check_qrconnect 当前是否仍然可用。
关键点：check_qrconnect 必须带上 ``x-tt-passport-csrf-token`` 请求头
（值取 cookie 里的 passport_csrf_token），否则官方一律返回
``error_code 2035「非法请求」``，表现为面板永远停在「等待扫码…」。

运行：在仓库根目录执行  python qr_diagnose.py
退出码：0 正常 / 1 拿不到 token / 2 轮询被拒绝
"""
import asyncio
import json
import os
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from doubao_work2api.qr_login import PASSPORT, qr_params  # noqa: E402
from doubao_work2api.transport import USER_AGENT  # noqa: E402


async def main() -> int:
    headers = {'User-Agent': USER_AGENT, 'Referer': 'https://www.doubao.com/',
               'Origin': 'https://www.doubao.com'}
    async with httpx.AsyncClient(http2=True, follow_redirects=False, timeout=25,
                                 headers=headers) as client:
        # 与真实流程一致：先落地设备 Cookie（ttwid / odin_tt 等）
        await client.get('https://www.doubao.com/chat/')
        qr = await client.get(PASSPORT + 'get_qrcode/', params=qr_params())
        data = (qr.json() or {}).get('data') or {}
        token = str(data.get('token') or '')
        print('[1] get_qrcode  HTTP', qr.status_code,
              '| error_code', repr(data.get('error_code')),
              '| token 长度', len(token))
        print('    二维码来源:',
              'base64 图片' if data.get('qrcode') else data.get('qrcode_index_url', '无'))
        if not token:
            print('!! 官方没有下发 token，无法继续。')
            return 1

        csrf = client.cookies.get('passport_csrf_token', '')
        print('[2] csrf cookie:', (csrf[:12] + '…') if csrf else '(缺失)')
        resp = await client.get(
            PASSPORT + 'check_qrconnect/', params=qr_params({'token': token}),
            headers={'x-tt-passport-csrf-token': csrf} if csrf else {})
        poll = resp.json()
        pdata = poll.get('data') or {}
        print('[3] check_qrconnect  HTTP', resp.status_code,
              '| error_code', repr(pdata.get('error_code')),
              '| status', repr(pdata.get('status')))
        print('    RAW:', json.dumps(poll, ensure_ascii=False)[:200])

        if str(pdata.get('error_code', '0')) != '0':
            print('\n结论：轮询接口被拒绝，扫码登录不可用。')
            print('     若是 2035，检查 x-tt-passport-csrf-token 请求头是否带上。')
            return 2
        print('\n结论：扫码链路正常（status=%r，new 表示等待扫码）。' % pdata.get('status'))
        return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
