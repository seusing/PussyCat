import {afterEach,describe,expect,it,vi} from 'vitest'

const mocks=vi.hoisted(()=>({tauri:false,openUrl:vi.fn(),save:vi.fn(),writeFile:vi.fn()}))
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>mocks.tauri}))
vi.mock('@tauri-apps/plugin-opener',()=>({openUrl:mocks.openUrl}))
vi.mock('@tauri-apps/plugin-dialog',()=>({save:mocks.save}))
vi.mock('@tauri-apps/plugin-fs',()=>({writeFile:mocks.writeFile}))
import {openWrssExternal,saveWrssBlob} from './wrssExternal'

afterEach(()=>{mocks.tauri=false;vi.restoreAllMocks();mocks.openUrl.mockReset();mocks.save.mockReset();mocks.writeFile.mockReset()})
describe('wrssExternal',()=>{
 it('opens links in a browser tab outside Tauri',async()=>{const opened=vi.spyOn(window,'open').mockImplementation(()=>null);await openWrssExternal('https://example.com/article');expect(opened).toHaveBeenCalledWith('https://example.com/article','_blank','noopener,noreferrer');expect(mocks.openUrl).not.toHaveBeenCalled()})
 it('uses the Tauri opener and binary save APIs in the desktop shell',async()=>{mocks.tauri=true;mocks.save.mockResolvedValue('C:/tmp/export.csv');await openWrssExternal('https://example.com/article');await saveWrssBlob('export.csv',new Blob(['a,b']));expect(mocks.openUrl).toHaveBeenCalledWith('https://example.com/article');expect(mocks.writeFile).toHaveBeenCalledWith('C:/tmp/export.csv',expect.any(Uint8Array))})
})
