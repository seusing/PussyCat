import {act,fireEvent,render,screen} from '@testing-library/react'
import {describe,expect,it,vi} from 'vitest'
import '@testing-library/jest-dom/vitest'

const api=vi.hoisted(()=>({
 fetchWrssAuth:vi.fn(),clearWrssCache:vi.fn(),
 fetchWrssArticleSyncState:vi.fn(()=>Promise.resolve({cooldown_until:0,recent_error_code:null})),
 fetchWrssSyncTask:vi.fn(),updateAllWrssSources:vi.fn(),updateWrssSource:vi.fn(),
}))
vi.mock('./wrssClient',()=>api)
vi.mock('./WrssArticleList',()=>({default:()=> <div data-testid="articles"/>}))
vi.mock('./WrssSourceDeck',()=>({default:()=> <div data-testid="sources"/>}))
vi.mock('./WrssAuthorization',()=>({default:(props:{onAuthChange:(state:{login:boolean})=>void})=><div data-testid="authorization"><button onClick={()=>props.onAuthChange({login:false})}>保持未授权</button></div>}))
vi.mock('./WrssExports',()=>({default:()=>null}))
vi.mock('./WrssMore',()=>({default:(props:{onRefresh:()=>void})=><button onClick={props.onRefresh}>模拟刷新公众号数据</button>}))
import WrssWorkspace from './WrssWorkspace'

describe('WrssWorkspace auth state',()=>{
 it('does not let an older sys response overwrite a later unauthorized event',async()=>{let resolve!:(value:{login:boolean})=>void;api.fetchWrssAuth.mockReturnValue(new Promise(next=>{resolve=next}));render(<WrssWorkspace/>);act(()=>window.dispatchEvent(new Event('wrss:unauthorized')));expect(screen.getByTestId('wrss-unauthorized')).toBeVisible();expect(screen.queryByTestId('articles')).not.toBeInTheDocument();expect(screen.queryByTestId('sources')).not.toBeInTheDocument();await act(async()=>resolve({login:true}));expect(screen.getByTestId('wrss-unauthorized')).toBeVisible();expect(screen.queryByText(/已授权/)).not.toBeInTheDocument()})
 it('mounts article content after authorization succeeds',async()=>{api.fetchWrssAuth.mockResolvedValue({login:true});render(<WrssWorkspace/>);expect(await screen.findByTestId('articles')).toBeVisible();expect(screen.queryByTestId('wrss-unauthorized')).not.toBeInTheDocument()})
 it('keeps the authorization view open when an already unauthorized check repeats',async()=>{api.fetchWrssAuth.mockResolvedValue({login:false});render(<WrssWorkspace/>);fireEvent.click(await screen.findByRole('button',{name:'去授权'}));expect(screen.getByTestId('authorization')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'保持未授权'}));expect(screen.getByTestId('authorization')).toBeVisible();expect(screen.queryByTestId('wrss-unauthorized')).not.toBeInTheDocument()})
 it('retries a failed initial authorization check',async()=>{api.fetchWrssAuth.mockRejectedValueOnce(new Error('host offline')).mockResolvedValueOnce({login:true});render(<WrssWorkspace/>);const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent('host offline');fireEvent.click(screen.getByRole('button',{name:'重试授权状态'}));expect(await screen.findByTestId('articles')).toBeVisible()})
 it('ignores a stale authorization error after a newer unauthorized event',async()=>{let reject!:(error:Error)=>void;api.fetchWrssAuth.mockReturnValue(new Promise((_resolve,next)=>{reject=next}));render(<WrssWorkspace/>);act(()=>window.dispatchEvent(new Event('wrss:unauthorized')));await act(async()=>reject(new Error('stale failure')));expect(screen.queryByText('stale failure')).not.toBeInTheDocument();expect(screen.getByTestId('wrss-unauthorized')).toBeVisible()})
 it('unmounts all data panes when an authorized session becomes unauthorized',async()=>{api.fetchWrssAuth.mockResolvedValue({login:true});render(<WrssWorkspace/>);expect(await screen.findByTestId('articles')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'已订阅公众号'}));expect(screen.getByTestId('sources')).toBeInTheDocument();act(()=>window.dispatchEvent(new Event('wrss:unauthorized')));expect(screen.queryByTestId('articles')).not.toBeInTheDocument();expect(screen.queryByTestId('sources')).not.toBeInTheDocument();expect(api.clearWrssCache).toHaveBeenCalled()})
 it('rechecks authorization on a manual data refresh and unmounts stale content',async()=>{api.fetchWrssAuth.mockResolvedValueOnce({login:true}).mockResolvedValueOnce({login:false});render(<WrssWorkspace/>);expect(await screen.findByTestId('articles')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'模拟刷新公众号数据'}));expect(await screen.findByTestId('wrss-unauthorized')).toBeVisible();expect(screen.queryByTestId('articles')).not.toBeInTheDocument()})
})
