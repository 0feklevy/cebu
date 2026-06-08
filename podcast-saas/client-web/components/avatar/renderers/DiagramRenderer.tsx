'use client';

const HEIGHT_SCRIPT = `<script>
(function(){
  function report(){
    var h=Math.max(document.documentElement.scrollHeight||0,document.body?document.body.scrollHeight||0:0);
    if(h<50){var svg=document.querySelector('svg');if(svg){var r=svg.getBoundingClientRect();h=r.height||h;}}
    if(h<50){h=400;}
    window.parent.postMessage({type:'DIAGRAM_HEIGHT',height:Math.min(Math.max(h,200),900)},'*');
  }
  if(document.readyState==='complete'){report();}else{window.addEventListener('load',report);}
  setTimeout(report,300);setTimeout(report,800);
})();
</script>`;

export function DiagramRenderer({ html, iframeHeight }: { html: string; iframeHeight?: number }) {
  const srcDoc = html.includes('</body>')
    ? html.replace(/<\/body>/i, HEIGHT_SCRIPT + '</body>')
    : html + HEIGHT_SCRIPT;

  return (
    <div className="avatar-diagram-renderer">
      <iframe
        srcDoc={srcDoc}
        title="Diagram"
        sandbox="allow-scripts"
        style={{ width: '100%', height: iframeHeight ?? 320, border: 'none', display: 'block' }}
      />
    </div>
  );
}
