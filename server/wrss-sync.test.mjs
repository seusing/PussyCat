// @vitest-environment node
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bundled = fileURLToPath(new URL('../artifacts/wrss-startup-probe/home/wrss/versions/py/Scripts/python.exe', import.meta.url))
const python = existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python.exe' : 'python3'

describe('managed WeRSS synchronization', () => {
  it('deduplicates active sources and blocks untouched queued work after 200013', () => {
    const root = mkdtempSync(join(tmpdir(), 'wrss-sync-probe-'))
    const script = join(root, 'probe.py')
    const modulePath = fileURLToPath(new URL('./wrss-sync.py', import.meta.url))
    writeFileSync(script, String.raw`
import importlib.util, json, os, sys, types
module_path, data_dir = sys.argv[1:]
os.environ['PUSSYCAT_WRSS_DATA_DIR'] = data_dir

def package(name):
    value = types.ModuleType(name); value.__path__ = []; sys.modules[name] = value; return value
package('core'); package('core.models'); package('driver'); package('apis')

class Field:
    def __eq__(self, value): return value
class Feed:
    id = Field()
    def __init__(self, id): self.id=id; self.faker_id='fake-'+id; self.mp_name=id; self.update_time=0
class Article: mp_id = Field()
feeds = {'one': Feed('one'), 'two': Feed('two')}
article_counts = {'one': 0, 'two': 0}
class Query:
    def __init__(self, model): self.model=model; self.value=None
    def filter(self, value): self.value=value; return self
    def first(self): return feeds.get(self.value)
    def count(self): return article_counts.get(self.value, 0) if self.model is Article else 0
class Session:
    def query(self, model): return Query(model)
    def expire_all(self): pass
    def close(self): pass
class DB:
    @staticmethod
    def get_session(): return Session()

db=types.ModuleType('core.db'); db.DB=DB; sys.modules['core.db']=db
feed=types.ModuleType('core.models.feed'); feed.Feed=Feed; sys.modules['core.models.feed']=feed
article=types.ModuleType('core.models.article'); article.Article=Article; sys.modules['core.models.article']=article
config=types.ModuleType('core.config'); config.cfg={'sync_interval':0}; sys.modules['core.config']=config
success=types.ModuleType('driver.success'); success.getStatus=lambda: True; sys.modules['driver.success']=success
mps=types.ModuleType('apis.mps'); mps.UpdateArticle=object(); sys.modules['apis.mps']=mps

queued=[]
class TaskQueue:
    @staticmethod
    def add_task(fn, *args, **kwargs): queued.append((fn,args)); return True
queue=types.ModuleType('core.queue'); queue.TaskQueue=TaskQueue; sys.modules['core.queue']=queue

network=[]; behavior={'fake-one':'rate'}
sync=None
class Gather:
    def get_Articles(self, faker_id, **kwargs):
        network.append(faker_id)
        if behavior.get(faker_id) == 'rate': sync.raise_sync_error(200013, 'frequency')
        if behavior.get(faker_id) == 'network': raise sync.PussycatSyncError(50200, 'network failed')
        if behavior.get(faker_id) == 'add': article_counts[faker_id.removeprefix('fake-')] += 3
class WxGather:
    def Model(self): return Gather()
wx=types.ModuleType('core.wx'); wx.WxGather=WxGather; sys.modules['core.wx']=wx

spec=importlib.util.spec_from_file_location('pussycat_sync', module_path)
sync=importlib.util.module_from_spec(spec); spec.loader.exec_module(sync)
clock=[1000]; sync.time.time=lambda: clock[0]
first=sync.submit_sync('one'); duplicate=sync.submit_sync('one'); second=sync.submit_sync('two')
queued_after_dedup=len(queued)
try: queued[0][0](*queued[0][1])
except sync.PussycatSyncError: pass
blocked_network=list(network)
blocked=sync.get_sync_task(second['task_id'])
spec2=importlib.util.spec_from_file_location('pussycat_sync_restart', module_path)
restart=importlib.util.module_from_spec(spec2); spec2.loader.exec_module(restart); restart.time.time=lambda: 1001
persisted=restart.article_sync_info()
restart.time.time=lambda: 3001
expired=restart.article_sync_info()
clock[0] += 1900
queued[1][0](*queued[1][1])
second_after=sync.get_sync_task(second['task_id'])

sync._tasks.clear(); sync._active_by_mp.clear(); sync._cooldown={'cooldown_until':0,'recent_error_code':None,'recent_error_message':''}; sync._save_cooldown(); queued.clear(); network.clear()
behavior['fake-one']='network'; failed=sync.submit_sync('one')
try: queued[-1][0](*queued[-1][1])
except sync.PussycatSyncError: pass
network_failed=sync.get_sync_task(failed['task_id'])

sync._tasks.clear(); sync._active_by_mp.clear(); queued.clear(); behavior.clear(); success.getStatus=lambda: False
unauthorized=sync.submit_sync('one')
try: queued[-1][0](*queued[-1][1])
except sync.PussycatSyncError: pass
unauthorized=sync.get_sync_task(unauthorized['task_id'])

sync._tasks.clear(); sync._active_by_mp.clear(); queued.clear(); success.getStatus=lambda: True
completed=sync.submit_sync('two'); queued[-1][0](*queued[-1][1]); completed=sync.get_sync_task(completed['task_id'])

sync._tasks.clear(); sync._active_by_mp.clear(); queued.clear(); behavior['fake-one']='add'
added=sync.submit_sync('one'); queued[-1][0](*queued[-1][1]); added=sync.get_sync_task(added['task_id'])
invalid=sync.submit_sync('MP_WXS_')
print(json.dumps({'dedup':first['task_id']==duplicate['task_id'],'queued_after_dedup':queued_after_dedup,'blocked':blocked,'blocked_network':blocked_network,'second_after':second_after,'persisted':persisted,'expired':expired,'network_failed':network_failed,'unauthorized':unauthorized,'completed':completed,'added':added,'invalid':invalid}))
`)
    const result = spawnSync(python, [script, modulePath, join(root, 'data')], { encoding: 'utf8' })
    expect(result.status, result.stderr || result.stdout).toBe(0)
    const value = JSON.parse(result.stdout.trim())
    expect(value.dedup).toBe(true)
    expect(value.queued_after_dedup).toBe(2)
    expect(value.blocked).toMatchObject({ status: 'blocked', code: 200013 })
    expect(value.second_after).toMatchObject({ status: 'blocked', code: 200013 })
    expect(value.blocked_network).toEqual(['fake-one'])
    expect(value.persisted).toMatchObject({ cooldown_until: 2800, recent_error_code: 200013 })
    expect(value.expired).toMatchObject({ cooldown_until: 0, recent_error_code: 200013 })
    expect(value.network_failed).toMatchObject({ status: 'failed', code: 50200 })
    expect(value.unauthorized).toMatchObject({ status: 'failed', code: 40101 })
    expect(value.completed).toMatchObject({ status: 'succeeded', code: 0, added: 0 })
    expect(value.added).toMatchObject({ status: 'succeeded', code: 0, added: 3 })
    expect(value.invalid).toMatchObject({ status: 'failed', code: 40003 })
  })
})
