from pathlib import Path
p=Path('admin/index.html')
s=p.read_text()
s=s.replace('      <section id="ops-dashboard"', '      <details class="workspace-tools" id="workspace-tools"><summary>Upload, live cast &amp; frame status</summary><div class="workspace-tools-body">\n      <section id="ops-dashboard"', 1)
s=s.replace('      <button id="controls-toggle"', '      </div></details>\n      <button id="controls-toggle"', 1)
s=s.replace('      <div id="media-transform-tools"', '      <details class="workspace-tools" id="orientation-tools"><summary>Rotate, flip &amp; selection tools</summary>\n      <div id="media-transform-tools"', 1)
s=s.replace('      <div id="bulk-toolbar"', '      </details>\n      <div id="bulk-toolbar"', 1)
p.write_text(s)
p=Path('admin/src/activity.css')
s=p.read_text().replace('}.tile', '}#grid .tile').replace(',.tile', ',#grid .tile').replace('.list-layout .', '#grid.list-layout .')
s+='''
/* Keep the library primary; secondary administration tools open on demand. */
.workspace-tools{border:1px solid var(--line);border-radius:.8rem;background:var(--panel);margin:0 0 .7rem;overflow:hidden}
.workspace-tools>summary{padding:.8rem 1rem;font-size:.82rem;min-height:44px}
.workspace-tools-body{padding:.7rem}.workspace-tools-body #live-cast{margin-bottom:0}
#orientation-tools #media-transform-tools{padding:0 .7rem .7rem;margin:0}
.activity-topline input,.activity-topline select,.count-range-grid input{font:inherit;font-size:.82rem;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:.65rem;padding:.6rem}
.media-usage{font-size:.72rem;line-height:1.35}
@media(max-width:600px){
  header{gap:.35rem;flex-wrap:wrap}header h1{font-size:.9rem}header h1 .muted{display:none}
  .modes{gap:0;margin-left:auto}.modes button{font-size:.8rem;padding:.4rem .5rem;min-height:44px}
  #logout{min-width:44px;width:44px;margin-left:0!important;padding:.4rem}
  .quick-actions #quick-controls{flex:0 0 auto;font-size:.82rem}
  .media-usage{font-size:.68rem}
}
'''
p.write_text(s)
