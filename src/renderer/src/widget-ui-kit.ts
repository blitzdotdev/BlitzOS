// The Blitz UI kit — a shared, dependency-free component library injected into EVERY srcdoc widget
// (right after BRIDGE_SHIM, see SurfaceFrame). A widget is a sandboxed `allow-scripts` iframe with no
// network and no same-origin, so it cannot `import` anything — the kit must be INLINED. This gives every
// widget the same design tokens + `<blitz-*>` web components, so the chat, the file manager, and any
// agent-authored widget compose ONE component set instead of each reinventing buttons/rows/bubbles.
//
// Two ways to use it:
//   - Declarative:  <blitz-message role="agent">Hi</blitz-message>, <blitz-input>, <blitz-row>, …
//   - Imperative:   window.blitz.ui.message('agent','Hi'), .row({...}), .input({...})
//
// Tokens are explicit values (a sandboxed iframe doesn't inherit the OS's CSS vars) chosen to match the
// OS dark theme. Keep this in sync with widget-catalog.mjs's WIDGET_AUTHORING_MD.
//
// Sandboxed `allow-scripts` srcdoc CAN `customElements.define` + Shadow DOM (no same-origin needed).

export const UI_KIT = `<style>
:root{
  --blitz-accent:#2563eb; --blitz-accent-ink:#ffffff;
  --blitz-bg:#0d1117; --blitz-surface:#161b22; --blitz-surface-2:#1c2230;
  --blitz-text:#e6edf3; --blitz-text-dim:#9aa4b2;
  --blitz-hairline:#30363d; --blitz-radius:10px; --blitz-radius-sm:7px;
  --blitz-font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
}
html,body{margin:0;height:100%;background:var(--blitz-bg);color:var(--blitz-text);font-family:var(--blitz-font);font-size:13px}
body{display:flex;flex-direction:column;overflow:hidden}
*{box-sizing:border-box}
</style>
<script>
(function(){
  if (window.__blitzUIKit) return; window.__blitzUIKit = true;
  function el(tag, attrs, kids){ var n=document.createElement(tag); if(attrs) for(var k in attrs){ if(k==='text') n.textContent=attrs[k]; else if(k==='html') n.innerHTML=attrs[k]; else n.setAttribute(k, attrs[k]); } (kids||[]).forEach(function(c){ n.appendChild(typeof c==='string'?document.createTextNode(c):c); }); return n; }
  function shadow(host, css, html){ var sr=host.attachShadow({mode:'open'}); sr.innerHTML='<style>'+css+'</style>'+(html||'<slot></slot>'); return sr; }

  // <blitz-titlebar> — a small header strip with a <slot> for the title.
  customElements.define('blitz-titlebar', class extends HTMLElement{ connectedCallback(){ if(this.shadowRoot)return; shadow(this,
    ':host{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:8px 11px;font-weight:600;font-size:12px;color:var(--blitz-text-dim);border-bottom:1px solid var(--blitz-hairline);background:var(--blitz-surface)}'); }});

  // <blitz-list> — a flex-growing, scrollable column. The chat transcript / file list lives here.
  customElements.define('blitz-list', class extends HTMLElement{ connectedCallback(){ if(this.shadowRoot)return; shadow(this,
    ':host{display:flex;flex-direction:column;gap:6px;flex:1 1 0;min-height:0;overflow-y:auto;padding:10px}'); }});

  // <blitz-message role="user|agent"> — a chat bubble. Content via slot.
  customElements.define('blitz-message', class extends HTMLElement{ connectedCallback(){ if(this.shadowRoot)return; var u=(this.getAttribute('role')==='user');
    shadow(this, ':host{display:flex;'+(u?'justify-content:flex-end':'justify-content:flex-start')+'}'+
      '.b{max-width:88%;padding:7px 11px;border-radius:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word;border:1px solid var(--blitz-hairline);'+
      (u?'background:var(--blitz-accent);color:var(--blitz-accent-ink);border-color:transparent':'background:var(--blitz-surface-2);color:var(--blitz-text)')+'}',
      '<div class="b"><slot></slot></div>'); }});

  // <blitz-row name meta kind> — a file-manager row (icon + name + meta). Fires 'open' on dblclick/Enter.
  customElements.define('blitz-row', class extends HTMLElement{ connectedCallback(){ if(this.shadowRoot)return;
    var dir=(this.getAttribute('kind')==='dir'); var name=this.getAttribute('name')||''; var meta=this.getAttribute('meta')||'';
    shadow(this, ':host{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:var(--blitz-radius-sm);cursor:default;user-select:none}'+
      ':host(:hover){background:var(--blitz-surface-2)}'+
      '.ic{width:22px;height:22px;flex:0 0 auto;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;'+
      (dir?'background:color-mix(in srgb,var(--blitz-accent) 22%,transparent);color:var(--blitz-accent)':'background:var(--blitz-surface-2);color:var(--blitz-text-dim);border:1px solid var(--blitz-hairline)')+'}'+
      '.nm{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt{flex:0 0 auto;color:var(--blitz-text-dim);font-size:11px}',
      '<div class="ic"><slot name="icon">'+(dir?'▸':(this.getAttribute('ext')||'').slice(0,4).toUpperCase())+'</slot></div><div class="nm">'+name.replace(/[<>&]/g,'')+'</div><div class="mt">'+meta.replace(/[<>&]/g,'')+'</div>');
    var fire=function(){ this.dispatchEvent(new CustomEvent('open',{bubbles:true,detail:{name:name,kind:this.getAttribute('kind'),path:this.getAttribute('path')}})); }.bind(this);
    this.addEventListener('dblclick', fire); this.tabIndex=0; this.addEventListener('keydown',function(e){ if(e.key==='Enter') fire(); }); }});

  // <blitz-input placeholder> — a one-line composer. Fires 'send' {detail:{text}} on Enter / Send button, then clears.
  customElements.define('blitz-input', class extends HTMLElement{ connectedCallback(){ if(this.shadowRoot)return;
    var sr=shadow(this, ':host{display:flex;gap:7px;flex:0 0 auto;padding:9px;border-top:1px solid var(--blitz-hairline);background:var(--blitz-surface)}'+
      'input{flex:1;background:var(--blitz-bg);color:var(--blitz-text);border:1px solid var(--blitz-hairline);border-radius:var(--blitz-radius-sm);padding:8px 10px;font:inherit;outline:none}'+
      'input:focus{border-color:var(--blitz-accent)}'+
      'button{appearance:none;border:none;background:var(--blitz-accent);color:var(--blitz-accent-ink);border-radius:var(--blitz-radius-sm);padding:0 14px;font:inherit;font-weight:600;cursor:pointer}',
      '<input type="text" /><button>Send</button>');
    var inp=sr.querySelector('input'), btn=sr.querySelector('button'); var ph=this.getAttribute('placeholder'); if(ph) inp.placeholder=ph;
    var fire=function(){ var t=inp.value.trim(); if(!t)return; inp.value=''; this.dispatchEvent(new CustomEvent('send',{bubbles:true,detail:{text:t}})); }.bind(this);
    inp.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); fire(); } }); btn.addEventListener('click',fire);
    this.focusInput=function(){ inp.focus(); }; }});

  // <blitz-button> — a styled button (slot for label). variant="ghost" for a quiet one.
  customElements.define('blitz-button', class extends HTMLElement{ connectedCallback(){ if(this.shadowRoot)return; var ghost=(this.getAttribute('variant')==='ghost');
    shadow(this, ':host{display:inline-flex}'+
      'button{appearance:none;border:none;border-radius:var(--blitz-radius-sm);padding:6px 12px;font:inherit;font-weight:600;cursor:pointer;'+
      (ghost?'background:transparent;color:var(--blitz-text-dim);border:1px solid var(--blitz-hairline)':'background:var(--blitz-accent);color:var(--blitz-accent-ink)')+'}',
      '<button><slot></slot></button>'); }});

  // Imperative helpers under window.blitz.ui (the bridge runs first, so window.blitz exists). Mirrors the tags.
  function attach(){
    if(!window.blitz){ return setTimeout(attach, 0); } // bridge not up yet — retry next tick
    window.blitz.ui = {
      el: el,
      titlebar: function(t){ return el('blitz-titlebar', {text:t}); },
      list: function(items){ var l=el('blitz-list'); (items||[]).forEach(function(i){ l.appendChild(i); }); return l; },
      message: function(role, text){ return el('blitz-message', {role:role, text:text}); },
      row: function(o){ o=o||{}; return el('blitz-row', {name:o.name||'', meta:o.meta||'', kind:o.kind||'file', ext:o.ext||'', path:o.path||''}); },
      input: function(o){ o=o||{}; var i=el('blitz-input', {placeholder:o.placeholder||''}); if(o.onSend) i.addEventListener('send', function(e){ o.onSend(e.detail.text); }); return i; },
      button: function(label, onClick, variant){ var b=el('blitz-button', variant?{variant:variant}:{}, [label]); if(onClick) b.addEventListener('click', onClick); return b; }
    };
  }
  attach();
})();
</script>
`
