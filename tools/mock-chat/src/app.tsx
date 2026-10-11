import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const parameters = new URLSearchParams(location.search);
  const [chat, setChat] = useState('');
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [answer, setAnswer] = useState('');
  const [complete, setComplete] = useState(false);
  const [responseError, setResponseError] = useState(false);
  const generation = useRef(0);
  function reset() {
    generation.current++;
    setChat(crypto.randomUUID());
    setPrompt('');
    setFiles([]);
    setError('');
    setSubmitted(false);
    setAnswer('');
    setComplete(false);
    setResponseError(false);
  }
  function receive(list: File[]) {
    if (parameters.get('upload') === 'reject') {
      setError('仮サイトによる添付拒否');
      return;
    }
    setFiles((current) => [...current, ...list]);
  }
  async function send() {
    if (!prompt.trim() || submitted || error) return;
    setSubmitted(true);
    const current = generation.current;
    if (parameters.get('submission') === 'unknown') {
      setSubmitted(false);
      return;
    }
    const result = `# 仮の AI 回答\n\n質問を受信しました（実際の LLM は呼び出していません）。\n\n- 添付数: ${files.length}\n- 質問文字数: ${prompt.length}\n\n\`\`\`typescript\nconst received = true;\n\`\`\`\n\n| 項目 | 結果 |\n| --- | --- |\n| 新規チャット | OK |\n| 添付 | ${files.length} 件 |`;
    setAnswer(result.slice(0, 25));
    // 短時間テキストが安定しても完了ではない。
    await new Promise((resolve) =>
      setTimeout(resolve, Number(parameters.get('delay') || 800)),
    );
    if (generation.current !== current) return;
    if (parameters.get('response') === 'error') {
      setResponseError(true);
      return;
    }
    if (parameters.get('response') === 'never') return;
    setAnswer(result);
    setComplete(true);
  }
  return (
    <main data-adapter="mock-v1">
      <h1>Mock Chat</h1>
      <p className="note">
        Web AI Bridge 方式検証用 · 外部送信・LLM 呼び出しなし ·
        添付データはページのメモリ内のみ
      </p>
      {parameters.get('auth') === 'required' ? (
        <p data-testid="login-required">ログインが必要です（仮状態）</p>
      ) : (
        <>
          <button data-testid="new-chat" onClick={reset}>
            新しいチャット
          </button>
          <section data-testid="chat" data-chat-id={chat}>
            <div data-state={chat ? 'ready' : 'initial'} />
            <label htmlFor="composer">
              質問（Ctrl+V でファイル／画像を添付）
            </label>
            <textarea
              id="composer"
              data-testid="composer"
              value={prompt}
              disabled={!chat || submitted}
              onChange={(event) => setPrompt(event.target.value)}
              onPaste={(event) => {
                const pasted = Array.from(event.clipboardData.files);
                if (pasted.length) {
                  event.preventDefault();
                  receive(pasted);
                }
              }}
            />
            <div>
              {files.map((file, index) => (
                <span
                  className="card"
                  key={index}
                  data-testid="attachment"
                  data-state="ready"
                  data-name={file.name}
                  data-size={file.size}
                  data-type={file.type}
                >
                  {file.name} · {file.size} bytes
                </span>
              ))}
            </div>
            {error && <p data-testid="attachment-error">{error}</p>}
            <button
              data-testid="send"
              onClick={() => {
                void send();
              }}
              disabled={!chat || !prompt.trim() || submitted || Boolean(error)}
            >
              送信
            </button>
            {submitted && (
              <p data-testid="submitted">
                {complete ? '回答完了' : '回答生成中'}
              </p>
            )}
            {responseError && (
              <p data-testid="response-error">回答生成に失敗しました</p>
            )}
            {answer && (
              <pre
                data-testid="answer"
                data-state={complete ? 'complete' : 'generating'}
              >
                {answer}
              </pre>
            )}
          </section>
        </>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
