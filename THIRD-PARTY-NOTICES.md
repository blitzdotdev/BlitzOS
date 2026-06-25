# Third-Party Notices

BlitzOS bundles and depends on third-party software. Each component is the
property of its respective authors and is distributed under its own license,
reproduced or referenced below. This file is provided to satisfy the
attribution requirements of those licenses.

BlitzOS itself is licensed under the Apache License, Version 2.0 (see
`LICENSE` and `NOTICE`).

---

## Apache License 2.0

### @agent-socket/sdk

The agent-socket client SDK is vendored into this repository at
`vendor/agent-socket-sdk/` and bundled into the Electron main process.

- Project: agent-socket
- License: Apache-2.0 (see `vendor/agent-socket-sdk/LICENSE`)

The full Apache License 2.0 text applicable to this component is reproduced
in `LICENSE` at the root of this repository.

---

## MIT License

The following runtime and bundled dependencies are distributed under the MIT
License. The MIT license text is reproduced once below; it applies to each
listed component, with copyright held by the component's respective authors.

- **Electron** — © GitHub Inc. and Electron contributors —
  https://github.com/electron/electron
- **@xterm/xterm** — © The xterm.js authors —
  https://github.com/xtermjs/xterm.js
- **@xterm/addon-fit** — © The xterm.js authors —
  https://github.com/xtermjs/xterm.js
- **react** — © Meta Platforms, Inc. and affiliates —
  https://github.com/facebook/react
- **react-dom** — © Meta Platforms, Inc. and affiliates —
  https://github.com/facebook/react
- **react-markdown** — © Espen Hovlandsdal —
  https://github.com/remarkjs/react-markdown
- **remark-gfm** — © Titus Wormer —
  https://github.com/remarkjs/remark-gfm
- **ws** — © Einar Otto Stangvik and ws contributors —
  https://github.com/websockets/ws
- **sucrase** — © Alan Pierce and Sucrase contributors —
  https://github.com/alangpierce/sucrase
- **zustand** — © Paul Henschel and Poimandres contributors —
  https://github.com/pmndrs/zustand

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## ISC License

### tmux (bundled binary)

A prebuilt `tmux` binary is bundled at `vendor/bin/tmux` and used to back the
agent's resumable terminals. tmux is distributed under the ISC License.

- Project: tmux — https://github.com/tmux/tmux

```
Copyright (c) 2007 Nicholas Marriott <nicholas.marriott@gmail.com>

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

The bundled `tmux` binary is arm64-only (macOS, tmux 3.5a). It statically bundles libevent and dynamically links the system-provided ncurses (/usr/lib/libncurses.5.4.dylib). Attribution for both:
notices apply to the bundled binary:

- **libevent** — distributed under the BSD 3-Clause License —
  © Niels Provos, Nick Mathewson, and libevent contributors —
  https://github.com/libevent/libevent

  ```
  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

  1. Redistributions of source code must retain the above copyright notice,
     this list of conditions and the following disclaimer.
  2. Redistributions in binary form must reproduce the above copyright notice,
     this list of conditions and the following disclaimer in the documentation
     and/or other materials provided with the distribution.
  3. Neither the name of the author nor the names of its contributors may be
     used to endorse or promote products derived from this software without
     specific prior written permission.

  THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS "AS IS" AND ANY
  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
  DISCLAIMED. IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
  SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
  ```

- **ncurses** — distributed under an MIT-like (X11-style) license —
  © Free Software Foundation, Inc. —
  https://invisible-island.net/ncurses/

  ```
  Permission is hereby granted, free of charge, to any person obtaining a
  copy of this software and associated documentation files (the "Software"),
  to deal in the Software without restriction, including without limitation
  the rights to use, copy, modify, merge, publish, distribute, distribute
  with modifications, sublicense, and/or sell copies of the Software, and to
  permit persons to whom the Software is furnished to do so, subject to the
  following conditions:

  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  ABOVE COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
  WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
  IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
  ```

---

## SIL Open Font License 1.1

### Volkhov

The Volkhov font is bundled at
`src/renderer/src/assets/fonts/` (`Volkhov-400.woff2`, `Volkhov-700.woff2`)
and is distributed under the SIL Open Font License, Version 1.1.

- Copyright (c) 2011 by Cyreal (www.cyreal.org), with Reserved Font Name
  "Volkhov".

The full text of the SIL Open Font License 1.1 applicable to this font is
reproduced in `src/renderer/src/assets/fonts/OFL.txt`.
