import { act,render,screen } from '@testing-library/react'
import { afterEach,describe,expect,it,vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import WrssPanel from './WrssPanel'
const status=(state:string,extra={})=>({state,summary:state,reason_code:null,progress_log:[],version:null,size_label:'约 356 MB',checked_at:'now',...extra})
function response(body:unknown,ok=true){return Promise.resolve({ok,status:ok?200:500,headers:new Headers({'content-type':'application/json'}),json:async()=>body} as Response)}
afterEach(()=>vi.unstubAllGlobals())
describe('WrssPanel native workspace',()=>{
 it('renders the native workspace instead of an iframe when running',async()=>{vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('/vk/v1/')?response(status('running')):response({code:0,data:{list:[],total:0}})));await act(async()=>render(<WrssPanel/>));expect(await screen.findByTestId('wrss-native')).toBeVisible();expect(screen.queryByTitle('公众号')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'最新文章'})).toBeVisible()})
 it('marks preview mode from managed status',async()=>{vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('/vk/v1/')?response(status('running',{version:'preview'})):response({code:0,data:{list:[],total:0}})));await act(async()=>render(<WrssPanel/>));expect(await screen.findByText('预览数据')).toBeVisible()})
 it('keeps install and failure controls',async()=>{vi.stubGlobal('fetch',vi.fn(()=>response(status('not-installed'))));await act(async()=>render(<WrssPanel/>));expect(await screen.findByRole('button',{name:'启用公众号'})).toBeVisible()})
})
