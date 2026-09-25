"""PussyCat managed WeRSS article synchronization."""

import json
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path
from uuid import uuid4


COOLDOWN_SECONDS = 1800
HISTORY_LIMIT = 100
_lock = threading.RLock()
_tasks = OrderedDict()
_active_by_mp = {}
_cooldown_path = None
_cooldown = {"cooldown_until": 0, "recent_error_code": None, "recent_error_message": ""}


class PussycatSyncError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = int(code)


def _data_file():
    root = Path(os.environ.get("PUSSYCAT_WRSS_DATA_DIR") or "data")
    return root / "article-sync.json"


def _load_cooldown():
    global _cooldown_path, _cooldown
    path = _data_file()
    if path == _cooldown_path:
        return
    _cooldown_path = path
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        _cooldown = {
            "cooldown_until": int(value.get("cooldown_until") or 0),
            "recent_error_code": value.get("recent_error_code"),
            "recent_error_message": str(value.get("recent_error_message") or ""),
        }
    except (OSError, ValueError, TypeError):
        _cooldown = {"cooldown_until": 0, "recent_error_code": None, "recent_error_message": ""}


def _save_cooldown():
    path = _data_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(_cooldown, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def article_sync_info():
    with _lock:
        _load_cooldown()
        now = int(time.time())
        return {
            **_cooldown,
            "cooldown_until": _cooldown["cooldown_until"] if _cooldown["cooldown_until"] > now else 0,
        }


def ensure_sync_allowed():
    info = article_sync_info()
    if info["cooldown_until"]:
        raise PussycatSyncError(200013, "微信请求频率受限，请在冷却结束后手动重试")


def raise_sync_error(code, message):
    code = int(code or 50000)
    message = str(message or "文章抓取失败")
    if code == 200013:
        with _lock:
            _load_cooldown()
            _cooldown.update(
                cooldown_until=int(time.time()) + COOLDOWN_SECONDS,
                recent_error_code=200013,
                recent_error_message=message,
            )
            _save_cooldown()
            for task_id, task in list(_tasks.items()):
                if task["status"] != "queued":
                    continue
                task.update(
                    status="blocked",
                    code=200013,
                    message="微信请求频率受限，请在冷却结束后手动重试",
                    cooldown_until=_cooldown["cooldown_until"],
                )
                _remember(task)
                _active_by_mp.pop(task["mp_id"], None)
    raise PussycatSyncError(code, message)


def _remember(task):
    _tasks[task["task_id"]] = task
    _tasks.move_to_end(task["task_id"])
    completed = [task_id for task_id, value in _tasks.items() if value["status"] not in ("queued", "running")]
    while len(completed) > HISTORY_LIMIT:
        _tasks.pop(completed.pop(0), None)


def _set_task(task_id, **values):
    with _lock:
        task = _tasks[task_id]
        task.update(values)
        _remember(task)
        if task["status"] not in ("queued", "running"):
            _active_by_mp.pop(task["mp_id"], None)
        return dict(task)


def get_sync_task(task_id):
    with _lock:
        task = _tasks.get(task_id)
        return dict(task) if task else None


def _article_count(session, mp_id):
    from core.models.article import Article
    return session.query(Article).filter(Article.mp_id == mp_id).count()


def _execute(task_id, start_page=0, end_page=1):
    with _lock:
        current = _tasks.get(task_id)
        if not current or current["status"] not in ("queued", "running"):
            return
    task = _set_task(task_id, status="running", message="正在抓取文章")
    session = None
    try:
        ensure_sync_allowed()
        from driver.success import getStatus
        if not getStatus():
            raise PussycatSyncError(40101, "微信公众号授权已失效，请重新扫码授权")
        from core.db import DB
        from core.models.feed import Feed
        from core.wx import WxGather
        from apis.mps import UpdateArticle

        session = DB.get_session()
        feed = session.query(Feed).filter(Feed.id == task["mp_id"]).first()
        if not feed:
            raise PussycatSyncError(40401, "公众号不存在")
        if feed.id == "MP_WXS_" or not str(feed.faker_id or "").strip():
            raise PussycatSyncError(40003, "公众号标识不完整，请重新添加")
        before = _article_count(session, feed.id)
        gather = WxGather().Model()
        gather.get_Articles(
            feed.faker_id,
            Mps_id=feed.id,
            Mps_title=feed.mp_name,
            CallBack=UpdateArticle,
            start_page=start_page,
            MaxPage=end_page,
        )
        session.expire_all()
        added = max(0, _article_count(session, feed.id) - before)
        _set_task(
            task_id,
            status="succeeded",
            code=0,
            message="抓取完成" if added else "抓取完成，没有新增文章",
            added=added,
        )
    except PussycatSyncError as error:
        status = "blocked" if error.code == 200013 else "failed"
        _set_task(
            task_id,
            status=status,
            code=error.code,
            message=str(error),
            cooldown_until=article_sync_info()["cooldown_until"],
        )
        raise
    except Exception as error:
        _set_task(task_id, status="failed", code=50002, message=str(error) or "文章抓取失败")
        raise
    finally:
        if session is not None:
            session.close()


def submit_sync(mp_id, start_page=0, end_page=1):
    mp_id = str(mp_id or "").strip()
    task_id = str(uuid4())
    if not mp_id or mp_id == "MP_WXS_":
        task = {
            "task_id": task_id,
            "mp_id": mp_id,
            "status": "failed",
            "code": 40003,
            "message": "公众号标识不完整，请重新添加",
            "cooldown_until": 0,
        }
        with _lock:
            _remember(task)
        return dict(task)
    with _lock:
        _load_cooldown()
        current_id = _active_by_mp.get(mp_id)
        if current_id and _tasks.get(current_id, {}).get("status") in ("queued", "running"):
            return dict(_tasks[current_id])
        info = article_sync_info()
        task = {
            "task_id": task_id,
            "mp_id": mp_id,
            "status": "blocked" if info["cooldown_until"] else "queued",
            "code": 200013 if info["cooldown_until"] else 0,
            "message": "微信请求频率受限，请在冷却结束后手动重试" if info["cooldown_until"] else "任务已排队",
            "cooldown_until": info["cooldown_until"],
        }
        _remember(task)
        if info["cooldown_until"]:
            return dict(task)
        _active_by_mp[mp_id] = task_id
    session = None
    try:
        from core.config import cfg
        from core.db import DB
        from core.models.feed import Feed
        session = DB.get_session()
        feed = session.query(Feed).filter(Feed.id == mp_id).first()
        if feed is not None:
            sync_interval = int(cfg.get("sync_interval", 60))
            elapsed = int(time.time()) - int(feed.update_time or 0)
            task["time_span"] = elapsed
            if elapsed < sync_interval:
                task.update(status="failed", code=40402, message="请不要频繁更新操作")
                with _lock:
                    _remember(task)
                    _active_by_mp.pop(mp_id, None)
                return dict(task)
    except Exception:
        with _lock:
            _active_by_mp.pop(mp_id, None)
        raise
    finally:
        if session is not None:
            session.close()
    from core.queue import TaskQueue
    accepted = TaskQueue.add_task(
        _execute,
        task_id,
        start_page,
        end_page,
        max_retries=0,
        task_name="pussycat-sync:" + mp_id,
    )
    if not accepted:
        with _lock:
            _active_by_mp.pop(mp_id, None)
        return _set_task(task_id, status="failed", code=40901, message="任务提交失败")
    return dict(task)
