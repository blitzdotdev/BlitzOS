import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

type MonacoEnvironmentShape = {
  getWorker: (_workerId: string, label: string) => Worker;
};

type MonacoGlobalScope = typeof globalThis & {
  MonacoEnvironment?: MonacoEnvironmentShape;
};

let configured = false;

export function configureSessionMonacoWorkers(): void {
  if (configured) return;
  configured = true;

  const scope = globalThis as MonacoGlobalScope;
  scope.MonacoEnvironment = {
    getWorker: (_workerId, label) => {
      if (label === 'json') return new JsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return new HtmlWorker();
      }
      if (label === 'typescript' || label === 'javascript') {
        return new TypeScriptWorker();
      }
      return new EditorWorker();
    },
  };
}
