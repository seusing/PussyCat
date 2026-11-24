import { registerSiteAuthCommands } from '../_shared/site-auth.js';
import { whoamiOnCreator } from './region.js';

// 与上游一样在创作者中心查身份,大陆版和国际版(rednote)都查,输出多一列 region 标明登录在哪边。
registerSiteAuthCommands({
    site: 'xiaohongshu',
    domain: 'creator.xiaohongshu.com',
    loginUrl: 'https://creator.xiaohongshu.com/',
    columns: ['username', 'followers', 'region'],
    verify: whoamiOnCreator,
});
