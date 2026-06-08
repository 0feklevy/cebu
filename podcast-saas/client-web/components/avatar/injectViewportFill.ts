// Ported from darwin-avatar/client/src/utils/injectViewportFill.ts
// Wraps rAF callbacks in try/catch and scales/centers simulation HTML to fill the iframe.

export function withRafErrorCatch(html: string): string {
  if (!html) return '';
  const script = `<script id="__raf_safe__">(function(){var _r=window.requestAnimationFrame;window.requestAnimationFrame=function(cb){return _r.call(window,function(ts){try{cb(ts);}catch(e){console.error('[sim]',e.message);}});};})();<\/script>`;
  if (html.includes('<head>')) return html.replace('<head>', '<head>' + script);
  if (html.includes('<body>')) return html.replace('<body>', script + '<body>');
  return script + html;
}

export function injectViewportFill(html: string, preview = false): string {
  if (!html) return '';
  const rafThrottle = preview
    ? `<script id="__pv_raf__">(function(){var _r=window.requestAnimationFrame,n=0;window.requestAnimationFrame=function(cb){if(n++<10){return _r.call(window,function(ts){try{cb(ts);}catch(e){}});}return _r.call(window,function(){});};})();<\/script>`
    : '';
  const injection = rafThrottle + `
<style id="__vp__">
html{overflow:hidden!important;width:100%!important;height:100%!important;position:relative!important;}
body{margin:0!important;padding:0!important;overflow:visible!important;position:absolute!important;top:0!important;left:0!important;}
</style>
<script id="__vp_scale__">
(function(){
  var NW=500,NH=420;
  function scaleOld(){
    var vw=window.innerWidth,vh=window.innerHeight;
    if(!vw||!vh)return;
    var s=Math.min(vw/NW,vh/NH);
    var tx=(vw-NW*s)/2;
    var ty=(vh-NH*s)/2;
    var b=document.body;
    b.style.width=NW+'px';
    b.style.height=NH+'px';
    b.style.transformOrigin='0 0';
    b.style.transform='translate('+tx+'px,'+ty+'px) scale('+s+')';
  }
  function init(){
    if(document.getElementById('app')){
      requestAnimationFrame(function(){requestAnimationFrame(function(){window.dispatchEvent(new Event('resize'));});});
      return;
    }
    requestAnimationFrame(function(){requestAnimationFrame(scaleOld);});
    window.addEventListener('resize',scaleOld);
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}
  else{init();}
})();
<\/script>`;
  let result: string;
  if (html.includes('<head>')) result = html.replace('<head>', '<head>' + injection);
  else if (html.includes('<body>')) result = html.replace('<body>', injection + '<body>');
  else result = injection + html;
  return preview ? result : withRafErrorCatch(result);
}
