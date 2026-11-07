# Assistente de Som · Soundcraft Ui16

App web para ajudar na sonoplastia da igreja: analisa o som (microfone do tablet ou saída PHONES da mesa), sugere equalização por tipo de fonte, caça microfonia, conversa com a IA e aplica os ajustes direto na Ui16.

## Arquivos
- `assistente-de-som.html` — o app pronto (gerado pelo `build.sh`).
- `index.html` — carregador que fica no tablet: baixa a última versão deste repositório e guarda uma cópia para usar sem internet.
- `app.html` + `core.js` — código-fonte. Rode `./build.sh` para gerar o app.

## Instalação no tablet (uma vez)
1. Instale o app **Simple HTTP Server** na Play Store.
2. Copie o `index.html` para uma pasta do tablet e aponte o servidor para ela.
3. No Chrome, abra `http://127.0.0.1:8080/` (precisa ser 127.0.0.1 ou localhost).

Toda vez que abrir com internet, o app vem atualizado do GitHub.
