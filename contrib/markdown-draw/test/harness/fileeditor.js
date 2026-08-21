// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

// Stands up Monaco exactly the way web_src/js/features/codeeditor.ts does:
// a container next to the hidden textarea, one-way sync from the model into
// that textarea, and the instance published on window.codeEditors -- which is
// what gitea-draw.js writes through.

window.__monacoReady = new Promise((resolve) => {
  require.config({paths: {vs: '/monaco/min/vs'}});
  require(['vs/editor/editor.main'], () => {
    const textarea = document.getElementById('edit_area');
    const container = document.createElement('div');
    container.className = 'monaco-editor-container';
    textarea.parentNode.append(container);

    const model = monaco.editor.createModel(textarea.value, 'markdown', monaco.Uri.file('Draw.md'));
    const editor = monaco.editor.create(container, {
      model,
      automaticLayout: true,
      // codeeditor.ts sets this too (monaco-editor issue 5081); without it
      // Monaco uses the EditContext API and has no textarea to send keys to
      editContext: false,
    });

    model.onDidChangeContent(() => {
      textarea.value = editor.getValue({preserveBOM: true, lineEnding: ''});
      textarea.dispatchEvent(new Event('change'));
    });

    // web_src/js/globals.d.ts: "export editor for customization"
    if (!window.codeEditors) window.codeEditors = [];
    window.codeEditors.push(editor);

    document.querySelector('.editor-loading')?.remove();
    resolve(editor);
  });
});
