// Onde o site busca os modelos de transcrição.
// Vazio = direto do Hugging Face. Com a ponte no Cloudflare Workers (pasta cloudflare/), coloque o
// endereço dela terminando em "/", por exemplo: 'https://quicksub-modelos.SEU-USUARIO.workers.dev/'
export const MODEL_HOST = 'https://quicksub-modelos.ozer0tools-0e4.workers.dev/';
// Formato dos caminhos no servidor acima. A ponte do Workers usa o mesmo formato do Hugging Face.
// Para um espelho simples no R2 (workflow espelhar-modelos), use '{model}/'.
export const MODEL_PATH = '{model}/resolve/{revision}/';
