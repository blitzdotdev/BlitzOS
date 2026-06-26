// Shared helpers for the Apple-Events tab adapters (Safari + Chrome). The page-context JS blobs below are
// evaluated in the page's own world via `do JavaScript` / `execute javascript`, so the read/act vocabulary is
// IDENTICAL — keep it in ONE place so the two adapters never drift. Each blob returns a JSON string we parse back.

// A tab's favicon for the connector UI. The old connector extension passed Chrome's native `favIconUrl`; the
// Apple-Events adapters don't get that, so derive the site's OWN root favicon (privacy-preserving — it hits only
// the site the user is already on, no third-party favicon service, and no extra per-tab osascript). The UI's
// <Favicon> loads this directly; if that <img> fails (a 404, or a site like Instagram serving an HTML wall to the
// renderer's browser-flavored request), it falls back to a neutral main-process re-fetch (favicon-resolver.mjs),
// then to a globe glyph if even that can't get an image.
export function faviconForUrl(url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined // chrome://, about:, file:: no site favicon
    return u.origin + '/favicon.ico'
  } catch {
    return undefined
  }
}

// READ: scoped text read (selector or body), capped. Returns {url,title,text} or {error}.
export const READ_JS =
  "(function(a){var sel=a&&a.selector;var root=sel?document.querySelector(sel):document.body;if(!root)return JSON.stringify({error:'no match for '+sel});var max=(a&&a.max)||8000;return JSON.stringify({url:location.href,title:document.title,text:(root.innerText||'').slice(0,max)})})"

// ACT: runs ENTIRELY in the page (JS). 'click' fires the full pointer/mouse sequence (pointerover→move→down,
// mousedown, focus, pointerup, mouseup, click) so custom web widgets that listen for mousedown/pointer (Google
// Docs, etc.) actually respond — a bare el.click() dispatches only a lone `click` and silently no-ops on them.
// 'type' replays per-char keydown/keypress/beforeinput/input/keyup. NEVER escalate a web tab off this JS path.
export const ACT_JS = `(function(a){
  var el = a.selector ? document.querySelector(a.selector) : document.activeElement;
  function clickSeq(t){
    var r = t.getBoundingClientRect(), cx = r.left + r.width/2, cy = r.top + r.height/2;
    var base = {bubbles:true, cancelable:true, composed:true, view:window, clientX:cx, clientY:cy, screenX:cx, screenY:cy, button:0};
    function P(type, ex){ try { return new PointerEvent(type, Object.assign({pointerId:1, pointerType:'mouse', isPrimary:true}, base, ex||{})); } catch(e){ return new MouseEvent(type, Object.assign({}, base, ex||{})); } }
    function M(type, ex){ return new MouseEvent(type, Object.assign({}, base, ex||{})); }
    t.dispatchEvent(P('pointerover')); t.dispatchEvent(M('mouseover'));
    t.dispatchEvent(P('pointermove')); t.dispatchEvent(M('mousemove'));
    t.dispatchEvent(P('pointerdown',{buttons:1})); t.dispatchEvent(M('mousedown',{buttons:1}));
    if (t.focus) { try { t.focus(); } catch(e){} }
    t.dispatchEvent(P('pointerup')); t.dispatchEvent(M('mouseup'));
    return t.dispatchEvent(M('click'));
  }
  if (a.action==='click'){
    if(!el) return JSON.stringify({error:'no match for '+a.selector});
    var before = location.href, ok = clickSeq(el);
    return JSON.stringify({effect:{clicked:a.selector||true, defaultPrevented:!ok, urlBefore:before, url:location.href}});
  }
  if (a.action==='type'){
    if(!el) return JSON.stringify({error:'no match for '+a.selector});
    if(el.focus){ try{el.focus();}catch(e){} }
    var text = a.text==null?'':''+a.text, editable = ('value' in el);
    for(var i=0;i<text.length;i++){
      var ch=text[i], ko={key:ch, bubbles:true, cancelable:true};
      el.dispatchEvent(new KeyboardEvent('keydown', ko));
      el.dispatchEvent(new KeyboardEvent('keypress', ko));
      try{ el.dispatchEvent(new InputEvent('beforeinput',{data:ch,bubbles:true,cancelable:true,inputType:'insertText'})); }catch(e){}
      if(editable){ el.value=(el.value||'')+ch; } else { try{ document.execCommand('insertText',false,ch); }catch(e){ el.textContent=(el.textContent||'')+ch; } }
      try{ el.dispatchEvent(new InputEvent('input',{data:ch,bubbles:true,inputType:'insertText'})); }catch(e){ el.dispatchEvent(new Event('input',{bubbles:true})); }
      el.dispatchEvent(new KeyboardEvent('keyup', ko));
    }
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return JSON.stringify({effect:{value: editable? el.value : (el.textContent||'')}});
  }
  if (a.action==='set'){
    if(!el) return JSON.stringify({error:'no match for '+a.selector});
    if('value' in el){ el.value=a.text==null?'':''+a.text; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return JSON.stringify({effect:{value:el.value}}); }
    el.textContent=a.text==null?'':''+a.text; el.dispatchEvent(new Event('input',{bubbles:true})); return JSON.stringify({effect:{value:el.textContent}});
  }
  if (a.action==='key'){
    var t=el||document.activeElement||document.body, ko={key:a.key, bubbles:true, cancelable:true};
    t.dispatchEvent(new KeyboardEvent('keydown', ko)); t.dispatchEvent(new KeyboardEvent('keypress', ko)); t.dispatchEvent(new KeyboardEvent('keyup', ko));
    return JSON.stringify({effect:{key:a.key}});
  }
  return JSON.stringify({error:'unknown action '+a.action});
})`
