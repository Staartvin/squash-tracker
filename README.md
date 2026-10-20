# Squash Team Eindhoven

The squash tracker of Squash Team Eindhoven, a group of friends who met at Solar Team Eindhoven. The site wears Solar Team Eindhoven's yellow and black as a nod to that; it is unofficial and not affiliated with the team.

A single static page that tracks:

- **Subscription break-even:** for each subscriber, how much their visits this season would have cost without a subscription, measured against €315.
- **Leaderboard:** a rating for every player, plus wins, win %, points per game and week streaks.
- **Records & bragging rights:** longest week streak, regular of the month, hot hand, biggest upset, fiercest rivalry, marathon game and more.
- **Progress:** each player's points per game and rating over time, a GitHub-style activity calendar, milestones with what's next, and their record against each opponent.
- **Head-to-head heatmap:** who usually beats whom, at a glance.
- **Predictions:** the chance to win a rally, a game and a best-of-5 match for any two players, with a 90% interval, plus a backtest of how good the predictions have been.
- **Suggested head starts:** for uneven matches, e.g. "Vincent starts at 4–0", based on the ratings.
- **Monthly recap:** highlights, break-even progress and new milestones, with a copy-for-WhatsApp button.
- **History and input:** log a visit and its games from your phone at the club, protected by a shared group code.

No build step. The page is plain HTML, CSS and JavaScript, and the data lives in a free Supabase database.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The page. Upload these as they are. |
| `config.js` | Your settings: Supabase details, season start date, prices. |
| `fonts/` | Montserrat for headings, served from this repo (SIL Open Font License, see `fonts/OFL.txt`). |
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

Then open the page, go to **+ Log**, enter the group code, and add the players. For everyone with a subscription, fill in **Subscriber since** with the date it started. Each subscriber's year runs from their own date, so people who join later get their own break-even year. Leave the date empty for people without a subscription.

## 3. Hosting (GitHub Pages)

This repository is published with GitHub Pages from the `main` branch, root folder, at:
https://squash.swevels.com/

Every push to `main` updates the site within a minute or two. Settings live under the repository's **Settings → Pages**. The empty `.nojekyll` file tells Pages to serve the files as they are.

The custom domain comes from a DNS record `squash` CNAME `staartvin.github.io` at swevels.com, plus the `CNAME` file in this repository (GitHub adds it when you set the domain in Settings → Pages; don't delete it). The old address https://staartvin.github.io/squash-tracker/ redirects to the new one.

The page uses relative paths, so you can also copy `index.html`, `styles.css`, `app.js` and `config.js` into any other static host or subfolder.

## Database updates

If you set up the database before a change that needs one, run the matching file in the Supabase SQL Editor once (fresh installs via `schema.sql` already include it):

- `supabase/002_subscription_start.sql`: gives each player their own subscription start date.
- `supabase/003_head_starts_and_editing.sql`: head starts per game, and editing a whole session at once.

## Day to day

- **Log a visit:** on the **+ Log** page, pick the date and slot, tick who was there and add each game, for example 9–11. Logging the same date and slot again adds to that session, so a visit is never counted twice.
- **Share a session:** after saving, or from any session in **History**, press **Share on WhatsApp** to open WhatsApp with a summary filled in (games, wins, rating changes, streaks, new milestones, break-even and a link back), then pick the group. **Copy summary** puts the same text on the clipboard.
- **Fix a mistake:** with the group code entered, press **Edit** on a session in **History**. You can change the date, slot, who was there and every game, or delete the session.
- **Head starts:** when you pick two players for a game, the form suggests a head start if their ratings differ. Press **Use** to apply it, and enter the final scoreboard (head start included).
- **Change the group code:** run this in the Supabase SQL Editor:

  ```sql
  update private.settings
  set code_hash = extensions.crypt('new-code', extensions.gen_salt('bf'));
  ```

- **Prices change?** Edit `slotValues` and `subscriptionPrice` in `config.js`. Break-even is recalculated from the logged visits, so past visits use the new prices too.
- **Old visits without scores:** log them anyway. Pick the date and slot, tick who was there and press **Save visit**. Games are optional, and a visit still counts towards break-even.
- **Someone gets a subscription:** fill in their **Subscriber since** date on the Log page and press Save.
- **New subscription year:** nothing to do. Each subscriber's year rolls over on the anniversary of their start date, and the dashboard gets a picker for previous years.

## How the numbers work

**Break-even.** Each visit a subscriber logs counts what that visit would have cost them without a subscription: €10 off-peak and €14 on Friday peak. Friday off-peak isn't open to non-subscribers, so it's counted as €10; change `fri_offpeak` in `config.js` if you'd rather count it differently. Each subscriber is measured over their own year, starting from their **Subscriber since** date; visits before that date don't count. "At this pace" projects your visits so far across the rest of your year.

For people without a subscription, the dashboard shows what their visits over the last 12 months cost, and how much more it would take for a subscription to pay off.

**Rating.** Everyone starts at 1000. After each game, rating points move from one player to the other depending on how the result compares with what the ratings predicted (Elo, K = 32). A game's result is half the win and half your share of the points. So losing 9–11 to a much stronger player can still raise your rating, and getting better shows up before you start winning.

**Week streak.** The number of weeks in a row (Monday to Sunday) with at least one visit. A streak isn't broken until a whole week passes without a visit, so on Monday it's "on the line" and the leaderboard reminds everyone to play before Sunday.

**Records.** The upset is the win the ratings rated least likely at the time (under 40%). Nemesis and favourite opponent on a player's page need at least 3 games against that person.

**Head starts.** One point of head start counts as about 40 rating points, so a 200-point gap suggests starting at 5–0 (at most 8). Ratings take the head start into account: winning with one earns less than winning level, and points per game only count points actually won.

## Backups

The free Supabase plan has no automatic backups, so download one now and then:

- **On the site:** History page → **Backup**. The CSV files (games, visits, players) open in Excel, Numbers or Google Sheets. **Full backup (JSON)** keeps every table exactly as stored, ids included, so the database can be rebuilt from it.
- **In Supabase:** Table Editor → pick a table → **Export → CSV**.

**Predictions.** A Bayesian rally model: each player has a strength, and the strength difference gives the chance of winning one rally. Every rally counts as evidence (as half an observation, since rallies aren't fully independent), games from 180 days ago count half, head-start points are left out, and a normal prior keeps players with few games sensible. The posterior is approximated as normal (Laplace), which gives each matchup an uncertainty; game odds (to 11, win by two, from any head start) and best-of-5 odds are calculated exactly from the rally odds, with 90% intervals. The backtest predicts every past game from only the games before it and shows how often the favourite won, the Brier score and a calibration table.

## Notes

- Free Supabase projects pause after about a week without activity. Weekly use normally keeps yours awake, and you can unpause it from the Supabase dashboard.
- The group code is remembered in each browser after you enter it once. Use **Lock editing** on the Log page to forget it, for example on a shared computer.
