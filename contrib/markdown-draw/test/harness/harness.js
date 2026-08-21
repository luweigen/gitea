// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// Test-only helper shared by the harness pages.

// Produces exactly what Gitea's markdown renderer emits for a fenced code
// block, see the FormatWithSafeAttrs call in modules/markup/markdown/markdown.go:
//   <div class="code-block-container ..."><pre class="code-block is-loading">
//     <code class="chroma language-XXX display">escaped source</code></pre></div>
window.renderFence = (hostId, source, lang = 'js-draw') => {
  const host = document.getElementById(hostId);
  const container = document.createElement('div');
  container.className = 'code-block-container code-overflow-scroll';
  const pre = document.createElement('pre');
  pre.className = 'code-block is-loading';
  const code = document.createElement('code');
  code.className = `chroma language-${lang} display`;
  code.textContent = source; // the renderer escapes it; textContent is equivalent
  pre.append(code);
  container.append(pre);
  host.append(container);
  return container;
};
