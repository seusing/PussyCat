import { createServer as createViteServer } from 'vite'
import { listenPreviewHost } from '../server/preview-host.mjs'
let host,vite,closing=false
async function close(code=0){if(closing)return;closing=true;await Promise.allSettled([vite?.close(),new Promise(resolve=>host?host.close(resolve):resolve())]);process.exitCode=code}
try{host=await listenPreviewHost(0);const address=host.address(),hostUrl=`http://127.0.0.1:${address.port}`;vite=await createViteServer({server:{host:'127.0.0.1'},envFile:false,define:{'import.meta.env.VITE_NODE_HOST_URL':JSON.stringify(hostUrl)}});await vite.listen();vite.printUrls();console.log(`WRSS preview API: ${hostUrl}`)}catch(error){console.error(error);await close(1)}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());process.once('uncaughtException',error=>{console.error(error);void close(1)});process.once('unhandledRejection',error=>{console.error(error);void close(1)})
