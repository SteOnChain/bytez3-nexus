import { Ollama } from 'ollama';

const ollama = new Ollama({
  // host isn't set, so it should default
  // wait, ollama-js might not support api key natively?
});
console.log("ollama defaults:", ollama.config);
