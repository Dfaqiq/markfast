[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Dfaqiq/markfast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Dfaqiq/markfast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markfast

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/markdown-render-speed-02)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A faster drop-in for marked 18.1.3 — single-pass Markdown renderer, byte-identical HTML.

`parse(markdown)` returns exactly the HTML that `marked.parse(markdown)` returns with marked's default options (gfm true, breaks false, pedantic false, async false), for every string — CommonMark 0.31.2, GFM 0.29 extensions, and long generated documents alike. No token tree, no dependency: a single-pass index scanner that renders straight to HTML, with fast paths for plain paragraphs.

## Layout

- `parse.js` — the renderer (dependency-free ES module, Node built-ins only)
- `main.ts` — the make.fun driver: reads `/input/cases.json`, writes `/output/html.json`

## Use

```js
import { parse } from './parse.js';
parse('# hello\n\nworld'); // '<h1>hello</h1>\n<p>world</p>\n'
```

Built for the [markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02) bounty on make.fun. If you sign up through my referral link, I earn a small bonus: https://make.fun/r/wxmx885n

## License

MIT — see [LICENSE](LICENSE).
