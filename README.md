# Squash Crew tracker

A single static page that tracks:

- **Subscription break-even:** for each subscriber, how much their visits this season would have cost without a subscription, measured against €312.
- **Leaderboard:** a rating for every player, plus wins, win % and points per game.
- **Progress:** each player's points per game and rating over time, and their record against each opponent.
- **History and input:** log a visit and its games from your phone at the club, protected by a shared group code.

No build step. The page is plain HTML, CSS and JavaScript, and the data lives in a free Supabase database.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The page. Upload these as they are. |
| `config.js` | Your settings: Supabase details, season start date, prices. |
| `supabase/schema.sql` | Run this once in Supabase to create the database. Don't upload it to your site. |

## 1. Try it locally (demo mode)

With `supabaseUrl` left empty in `config.js`, the page runs in demo mode with sample data that is saved only in your browser.

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765. The demo group code is `demo`.

## 2. Set up Supabase (about 10 minutes)

1. Create a free account at https://supabase.com and make a new project. Any region in the EU is fine.
2. Open **SQL Editor → New query**. Paste in all of `supabase/schema.sql`.
3. **Replace `CHANGE-ME`** with the group code you'll share with your friends. Pick something longer than a few characters, because anyone with the code can add and delete games. Do this in the Supabase editor only, and don't commit your code to `schema.sql`: the repository is public.
4. Press **Run**. You should see "Success. No rows returned".
5. Go to **Project Settings → API Keys** (or click **Connect**) and copy:
   - the **Project URL** (`https://xxxx.supabase.co`)
   - the **publishable** key (`sb_publishable_…`), or on older projects the **anon public** key
6. Put both into `config.js`:

   ```js
   supabaseUrl: 'https://xxxx.supabase.co',
   supabaseKey: 'sb_publishable_…',
   ```

   This key is meant to be public. The database only allows reading, and every change goes through functions that check the group code first.

7. Set `seasonStart` in `config.js` to the date your subscription year started.

Then open the page, go to **+ Log**, enter the group code, and add the players. Tick **Subscriber** for the three of you who have the subscription.

## 3. Hosting (GitHub Pages)

This repository is published with GitHub Pages from the `main` branch, root folder:
https://staartvin.github.io/squash-tracker/

Every push to `main` updates the site within a minute or two. Settings live under the repository's **Settings → Pages**. The empty `.nojekyll` file tells Pages to serve the files as they are.

The page uses relative paths, so you can also copy `index.html`, `styles.css`, `app.js` and `config.js` into any other static host or subfolder.

## Day to day

- **Log a visit:** on the **+ Log** page, pick the date and slot, tick who was there and add each game, for example 9–11. Logging the same date and slot again adds to that session, so a visit is never counted twice.
- **Fix a mistake:** with the group code entered, the **History** page shows × buttons to delete games, remove people from a session or delete a whole session.
- **Change the group code:** run this in the Supabase SQL Editor:

  ```sql
  update private.settings
  set code_hash = extensions.crypt('new-code', extensions.gen_salt('bf'));
  ```

- **Prices change?** Edit `slotValues` and `subscriptionPrice` in `config.js`. Break-even is recalculated from the logged visits, so past visits use the new prices too.
- **New season:** nothing to do. Seasons run one year from `seasonStart`, and the dashboard has a season picker once there's more than one.

## How the numbers work

**Break-even.** Each visit a subscriber logs counts what that visit would have cost them without a subscription: €10 off-peak and €14 on Friday peak. Friday off-peak isn't open to non-subscribers, so it's counted as €10; change `fri_offpeak` in `config.js` if you'd rather count it differently. "At this pace" projects your visits so far across the rest of the season.

**Rating.** Everyone starts at 1000. After each game, rating points move from one player to the other depending on how the result compares with what the ratings predicted (Elo, K = 32). A game's result is half the win and half your share of the points. So losing 9–11 to a much stronger player can still raise your rating, and getting better shows up before you start winning.

## Notes

- Free Supabase projects pause after about a week without activity. Weekly use normally keeps yours awake, and you can unpause it from the Supabase dashboard.
- The group code is remembered in each browser after you enter it once. Use **Lock editing** on the Log page to forget it, for example on a shared computer.
