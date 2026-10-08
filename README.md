# Find Aircraft

Two aircraft are hidden on a 10 × 10 grid. Find both cockpits in as few shots as you can.

**[Play it here](https://ilovehhhyn.github.io/find-aircraft/)**

![A game in progress: one cockpit found, with several misses and body hits](docs/screenshot.png)

This is a remake of [npes87184/find-aircraft](https://github.com/npes87184/find-aircraft), a pencil-and-paper style deduction game. This version adds three aircraft shapes that are dealt at random, a redesigned board, keyboard play, a fly-past when you find both aircraft, accounts with a leaderboard, and a dark mode with its own rules.

## Rules

These are the rules for light mode, the standard game. Dark mode changes the goal and is described further down.

### Goal

Hit the **cockpit** of both hidden aircraft. Your score is the number of shots you took, so a lower score is better.

### Setup

At the start of every game, two aircraft are placed at random on the grid.

- Each aircraft is one of the three shapes below. The shape is chosen at random and separately for each aircraft, so the two may be different types or the same type.
- Each aircraft points up, right, down or left.
- The two aircraft never overlap, but they may touch.
- Every aircraft has exactly one cockpit, which is the square at its nose.

### The three shapes

`H` is the cockpit and `O` is a body square. Each shape is drawn here with its nose pointing up.

```
  Classic        Delta        Airliner
 10 squares    10 squares    11 squares

     H             H             H
   OOOOO          OOO            O
     O           OOOOO         OOOOO
    OOO            O             O
                                OOO
```

The same chart is shown next to the board while you play.

### Taking a shot

Pick any square you have not shot yet. One of three things happens:

| Result | Colour | What it means |
| --- | --- | --- |
| Miss | White | No aircraft occupies this square |
| Body | Dark blue | Part of an aircraft is here, but not its cockpit |
| Cockpit | Red | You have found one aircraft |

Those three colours are all the game tells you. Hitting a cockpit does not show the rest of that aircraft or say which shape it was, so its other squares stay hidden and still cost a shot each if you shoot them. Shooting a square that is already revealed does nothing and costs nothing.

### Winning

The game ends when both cockpits have been hit. Only then are both aircraft shown in full: they pulse from nose to tail and one aircraft flies across the board. Your best (lowest) score is remembered in your browser.

## Dark mode: avoid the cockpits

The moon button in the toolbar switches to dark mode, which turns the game around. Switching mode always deals a new game.

- **Goal:** uncover every body square of both aircraft.
- **Losing:** you may hit one cockpit and carry on. Hit both cockpits and you lose.
- **Misses** cost nothing.
- The three colours mean the same as in light mode, and a cockpit hit still reveals only that one square.
- The counter shows how many body squares you have found, not how many remain, because the total would reveal which shapes are hidden.
- Dark mode games are **not** counted on the leaderboard.

## Accounts and leaderboard

When you open the site, a dialog offers three choices: **sign up** with a name (shown on the leaderboard) and a password, **sign in** to an existing account, or **play as guest**.

- The person button in the toolbar opens the same dialog at any time, so you can sign up or sign in part-way through a game without losing it. A best score you earned as a guest moves into the account.
- The leaderboard button lists every player's best game: the fewest shots taken to find both aircraft in light mode.
- Scores are reported by the browser, so this is a leaderboard for friends, not a cheat-proof one. Use a password you do not use anywhere else.

### Where the data lives

Out of the box, accounts and scores are stored in the browser (`localStorage`), so the leaderboard only lists accounts made on the same device. To share one leaderboard between everyone:

1. Create a project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run [`supabase/schema.sql`](supabase/schema.sql).
3. Copy the project URL and the public key (labelled "anon public" or "publishable") into [`js/config.js`](js/config.js).

That key is meant to be public. The accounts table has row level security with no policies, so the key cannot read or write it directly; it can only call four database functions (sign up, sign in, submit a score, read the leaderboard). Passwords are stored as bcrypt hashes. Never put a Supabase access token or `service_role` key in this repository.

## Controls

- **Mouse or touch:** click or tap a square to shoot it.
- **Keyboard:** press Tab to reach the board, move with the arrow keys, and press Enter or Space to shoot.
- **New game:** deals two new aircraft at any time.
- **Toolbar:** leaderboard, light/dark mode, and your account.

## Run it locally

There is no build step and nothing to install. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

To run the tests for the game rules (Node 18 or newer):

```sh
node --test
```

## How the code is organised

| File | Purpose |
| --- | --- |
| `js/game.js` | The rules: shapes, random placement and shot resolution. No DOM access, so it runs in Node for the tests. |
| `js/ui.js` | Draws the board, handles input, switches mode and plays the animations. |
| `js/store.js` | Accounts, sessions and the leaderboard, with a browser-only backend and a Supabase backend. |
| `js/account.js` | The sign up / sign in dialog and the leaderboard dialog. |
| `js/config.js` | Supabase project URL and public key (empty by default). |
| `supabase/schema.sql` | The database table and functions. |
| `css/style.css` | Layout, colours and animation. |
| `tests/` | Tests for the rules of both modes and for the account store. |

To add or change a shape, edit the `SHAPES` list in `js/game.js`. Each shape is a list of `[row, column]` offsets from the cockpit with the nose pointing up, and the first offset must be the cockpit `[0, 0]`. The board, the chart and the placement logic all read from that list.

## Credits

The game idea and the Classic shape come from [npes87184/find-aircraft](https://github.com/npes87184/find-aircraft) by Yu-Chen Lin, which is MIT licensed. The code here is written from scratch. Text is set in [B612](https://b612-font.com/), the typeface Airbus commissioned for cockpit displays.

## License

[MIT](LICENSE)
