// 公众号文章页的精简样本,保留真实页面里取标题、作者、时间和正文用到的结构:
// #publish_time 在静态 HTML 里是空的,发布时间只在内联脚本的 var ct 里。
export const WECHAT_ARTICLE_CT = 1774922192

export const WECHAT_ARTICLE_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta property="og:title" content="苹果子公司因违反对俄制裁受到英国处罚" />
<meta property="og:url" content="https://mp.weixin.qq.com/s/abc" />
<meta property="og:article:author" content="" />
<meta name="author" content="" />
</head>
<body>
<h1 class="rich_media_title " id="activity-name">
<span class="js_title_inner">苹果子公司因违反对俄制裁受到英国处罚</span></h1>
<div id="meta_content" class="rich_media_meta_list">
  <a role="button" tabindex="0" class="wx_tap_link" id="js_name">
    合规小叨客              </a>
  <em id="publish_time" class="rich_media_meta rich_media_meta_text"></em>
</div>
<div class="rich_media_content js_underline_content" id="js_content" style="visibility: hidden; opacity: 0; "><p><span leaf="">正文内容</span></p><p><img class="rich_pages wxw-img" data-src="https://mmbiz.qpic.cn/mmbiz_jpg/x/640?wx_fmt=jpeg" alt="配图" /></p></div>
<script type="text/javascript">
var msg_title = '苹果子公司因违反对俄制裁受到英国处罚'.html(false);
var ct = "${WECHAT_ARTICLE_CT}";
var nickname = htmlDecode("合规小叨客");
</script>
</body>
</html>`
