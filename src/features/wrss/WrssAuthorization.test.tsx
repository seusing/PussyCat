import {act,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import '@testing-library/jest-dom/vitest'

const api=vi.hoisted(()=>({closeQr:vi.fn(),createQr:vi.fn(),fetchQrState:vi.fn(),fetchWrssAuth:vi.fn(),logoutWechat:vi.fn(),mockWrssAuth:vi.fn(),qrImageUrl:vi.fn(()=>'/qr'),refreshQr:vi.fn()}))
vi.mock('./wrssClient',()=>api)
import WrssAuthorization from './WrssAuthorization'

beforeEach(()=>{Object.values(api).forEach(mock=>mock.mockReset());api.qrImageUrl.mockReturnValue('/qr');api.fetchWrssAuth.mockResolvedValue({login:false});api.createQr.mockResolvedValue({data:{version:1,expires_at:100}});api.fetchQrState.mockResolvedValue({login_status:false,qr_code:true,scanned:false,version:1,expires_at:100});api.closeQr.mockResolvedValue({});vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve(new Response(new Blob(['qr']),{status:200}))))})
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})

describe('WrssAuthorization',()=>{
 it('keeps refresh busy until status reports a newer QR version',async()=>{vi.useFakeTimers();api.refreshQr.mockResolvedValue({data:{version:1,expires_at:100}});api.fetchQrState.mockResolvedValueOnce({login_status:false,qr_code:true,scanned:false,version:1,expires_at:100}).mockResolvedValueOnce({login_status:false,qr_code:true,scanned:false,version:1,expires_at:100}).mockResolvedValueOnce({login_status:false,qr_code:true,scanned:false,version:2,expires_at:200});render(<WrssAuthorization active mode="real" initialAuth={{login:false}}/>);fireEvent.click(screen.getByRole('button',{name:'扫码授权'}));await act(async()=>{await Promise.resolve();await Promise.resolve()});const refresh=screen.getByRole('button',{name:'刷新二维码'});fireEvent.click(refresh);await act(async()=>{await Promise.resolve()});expect(refresh).toBeDisabled();await act(async()=>{vi.advanceTimersByTime(1000);await Promise.resolve();await Promise.resolve();await Promise.resolve()});expect(refresh).toBeEnabled();expect(api.fetchQrState).toHaveBeenCalledTimes(3)})
})
