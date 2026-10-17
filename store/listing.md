# Store listing texts

Copy-paste material for Chrome Web Store and addons.mozilla.org (AMO).

## Name

مسیرها و محل قرار (برای نقشهٔ نشان)

## Summary (max 132 characters)

fa: چند مسیر هم‌زمان روی نقشهٔ نشان، مقایسهٔ آن‌ها و پیدا کردن محل قراری سر راه همه. غیررسمی.

en: Several routes at once on Neshan map, compare them, and find a meeting point on everyone’s way. Unofficial.

## Description (fa)

نقشهٔ نشان هر بار فقط یک مسیر نشان می‌دهد. این افزونه روی خود سایت neshan.org/maps یک پنل اضافه می‌کند تا:

• چند مسیر را هم‌زمان روی نقشهٔ نشان ببینید، هر کدام با اسم و رنگ خودش (خودرو، همگانی، موتور، پیاده، دوچرخه).
• زمان، مسافت و ساعت رسیدن مسیرها را کنار هم مقایسه کنید و بر اساس مبدا یا مقصد گروهشان کنید؛ مثلاً هر خانه‌ای که برای اجاره دیده‌اید را با همهٔ مقصدهایتان یک جا ببینید.
• برای چند نفر که از جاهای مختلف به مقصدهای مختلف می‌روند، محل قراری پیدا کنید که سر راه همه باشد و کمترین وقت اضافه را بگیرد، با ساعت رسیدن هر نفر.
• مسیرهای همگانی را با خط‌ها، ایستگاه‌ها، کرایه و پیاده‌روی ببینید.

مسیرها فقط در مرورگر خودتان ذخیره می‌شوند. افزونه رسمی نیست و به نشان وابستگی ندارد.

## Description (en)

Neshan’s map shows one route at a time. This extension adds a panel to neshan.org/maps that lets you:

• Show several named routes at once on Neshan’s own map (car, public transport, motorcycle, walking, bike).
• Compare their time, distance and arrival time side by side, grouped by origin or destination.
• Find a meeting point on the way for several people going from different places to different destinations, with the least extra time, and see when each person arrives.
• See public-transport routes with lines, stops, fare and walking.

Routes are stored only in your browser. Unofficial; not affiliated with Neshan.

## Category

Chrome: Productivity (or Travel) · Firefox: Search Tools / Other

## Permission justifications (Chrome “Privacy practices” tab)

- Single purpose: show and compare several routes on neshan.org’s map and find a meeting point for them.
- storage: keeps the user’s routes and settings between visits.
- Content scripts on https://neshan.org/maps*: the panel runs on Neshan’s map page and draws on that map; it only works on that site.
- Remote code: none (all code is in the package).
- Data usage: no user data is collected or transmitted to the developer. Privacy policy: https://github.com/vahidbaghi/neshan-routes/blob/main/PRIVACY.md

## Notes for Firefox reviewers

inpage.js is a bundle (esbuild, not minified) of src/inpage/*.js and src/lib/*.js. To rebuild from the attached source:
`npm install && node build.mjs` → dist/firefox (Node.js 20+). The same steps are in README.md.
