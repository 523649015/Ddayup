"""用户配额：进程内按用户每日提交计数。

按 x-hmdao-user-id 头标识用户，缺失视为 anonymous。
计数以本地日期（YYYY-MM-DD）为单位，跨日自动重置。
注意：进程内字典，网关重启即清零；如需持久化请外接 Redis / 数据库。
"""
from __future__ import annotations

import asyncio
import time

from config import USER_DAILY_QUOTA

# user_id -> {"date": "YYYY-MM-DD", "count": int}
_USAGE: dict[str, dict] = {}
_LOCK = asyncio.Lock()


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.localtime())


async def check_and_count(user_id: str) -> tuple[bool, int, int]:
    """检查并计入一次提交。

    返回 (allowed, used_after, quota)。
    - allowed=True 时已计入本次（count + 1）。
    - allowed=False 表示已超配额，不入计。
    - quota<=0 表示不限。
    """
    quota = USER_DAILY_QUOTA
    async with _LOCK:
        today = _today()
        rec = _USAGE.get(user_id)
        if not isinstance(rec, dict) or rec.get("date") != today:
            rec = {"date": today, "count": 0}
            _USAGE[user_id] = rec
        used = int(rec["count"])
        if quota > 0 and used >= quota:
            return False, used, quota
        rec["count"] = used + 1
        return True, int(rec["count"]), quota


async def get_usage(user_id: str) -> tuple[int, int]:
    """返回 (used, quota)，用于状态展示。"""
    quota = USER_DAILY_QUOTA
    async with _LOCK:
        today = _today()
        rec = _USAGE.get(user_id)
        if not isinstance(rec, dict) or rec.get("date") != today:
            return 0, quota
        return int(rec["count"]), quota


async def sweep_quota() -> None:
    """清理跨日残留记录（避免字典无限增长）。"""
    today = _today()
    async with _LOCK:
        stale = [u for u, r in _USAGE.items() if r.get("date") != today]
        for u in stale:
            _USAGE.pop(u, None)
