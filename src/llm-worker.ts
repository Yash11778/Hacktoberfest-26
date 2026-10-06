import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

// The model runs here so token generation never blocks the UI thread.
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => handler.onmessage(msg);
