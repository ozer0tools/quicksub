# QuickSub

Legendas automáticas em português, direto no navegador. Os vídeos não saem do seu computador: a transcrição (Whisper) e a gravação do vídeo legendado rodam na própria página.

**Usar:** https://ozer0tools.github.io/quicksub/

## Como funciona

- **Transcrição:** Whisper pelo [transformers.js](https://github.com/huggingface/transformers.js). Com placa de vídeo (WebGPU) usa o modelo turbo; sem ela, roda no processador com o modelo small, bem mais devagar.
- **Vídeo legendado:** a legenda é desenhada quadro a quadro e o MP4 é gerado pelo WebCodecs, via [mediabunny](https://github.com/Vanilagy/mediabunny).
- O modelo é baixado do Hugging Face na primeira vez e fica guardado no navegador.

Melhor no Chrome ou no Edge atualizados (gravam direto numa pasta e geram H.264). Para lotes grandes, a versão para Windows é mais rápida e mais precisa: veja em [Releases](https://github.com/ozer0tools/quicksub/releases).

## Desenvolvimento

```
npm install --ignore-scripts
npm run dev       # servidor local
npm run build     # gera a pasta dist
```

`?demo` no endereço troca a transcrição por um texto fixo, para testar a interface sem baixar o modelo.

A publicação no GitHub Pages é automática a cada envio para `main` (`.github/workflows/pages.yml`).

## Créditos

Fontes Montserrat, Inter, Poppins, Anton, Bebas Neue e Space Mono (SIL Open Font License). `coi-serviceworker` (MIT).
