# Dispatch: Hero Missions Minigame (Foundry VTT v13/v14, D&D 5e)

Author: Woodpecker

A notice-board minigame. Pin heroes to mission notices, send them out, and wait for them to return.

## Install
Unzip the `dispatch-minigame` folder into `Data/modules/` (the folder name must stay `dispatch-minigame`), enable it in your world, and reload.
Open the board with the route icon in the Token controls (GM), or let it open on a bound scene.

## Data files (`data/`)
- `heroes.json`: id, name, class, level, `img`, six stats (strength, agility, constitution, intelligence, wisdom, charisma), `quirk`, `proficiency`, `recruited`, `recruitable`.
  Put portraits in `data/portraits/` and set `"img": "file.png"`. Paths starting with `icons/`, `modules/`, `worlds/`, `systems/`, `http` or `/` are used as written.
- `missions.json`: 253 quests: three guaranteed-success tier 0 starter quests (1 hero, 100% chance) and 250 Waterdeep quests, 50 each in tiers 1-5. Each has as many hero slots as its tier (`slots`, max 5). Optional `hiddenSkill` grants advantage if any sent hero has that proficiency.
- Edit the files and reload Foundry. GM changes (levels, stats, recruit flags) are saved in the world and layered over these files.

## Playing
- **Board:** up to 10 notices (settings: minimum and maximum) are drawn at random from missions.json (visible tiers, not yet completed) and pinned in fixed, non-overlapping spots. Completed notices come down and are replaced.
- **Assigning:** drag recruited hero cards onto a notice (click a hero on a notice, or drag back, to remove). Assignments are shared live. A party may be sent with any number of heroes from one up to the notice's slots; fewer heroes means lower odds.
- **Players see:** hero card (portrait, name, level, class), combined stats of the party on each notice, and an odds word: Suicidal (<15%), Dicey (15-40%), Coin Toss (40-60%), Promising (60-90%), Assured (>90%).
- **GM also sees:** requirements, success percentage, and each quest's hidden skill (highlighted when the party has it).
- **Deploy:** players press Deploy; the GM approves (see settings). A wax seal marks a notice while its party is out.
- **Outcome:** d100 against the chance. Hidden-skill advantage rolls twice and keeps the better result. Bottom 20% of the winning range is a critical success (double rewards). Top 20% of the losing range is a critical failure (all heroes injured); an ordinary failure injures one hero.
- **After a mission:** successful heroes celebrate (unavailable); injured heroes recover. Both durations are settings.
- **Recruiting:** the Recruits parchment (bottom right) lists heroes marked available. Click a name for the hero card and press Recruit; the GM approves. Only heroes marked available are listed, for the GM too. The GM can hide one with the eye icon, and offers heroes using the Available checkboxes in the settings window.
- **Hero cards:** click a card for the full stats card. It stays open until you click somewhere else. **Retire** removes the hero from the roster (the GM confirms, per the approval setting).
- **Level-ups and training:** the GM levels heroes up (arrow on a card, or "Level up all"). A badge appears; players click the card, spend the stat points, and press Train. Anyone with the card open sees changes live. Trained heroes are hidden from players and unavailable for the training time.
- **Mission log:** a "Dispatch Mission Log" journal gets a page per completed mission (info, party, outcome).

## Settings (Configure Settings, or the Settings button on the GM toolbar)
GM must confirm recruiting/deploying/training; show the board background; show the Dispatch button to players; maximum recruited heroes; minimum and maximum notices; visible tiers; stat points per level-up; training hours; injury multiplier (failure and critical failure); celebrating hours; hero level/stat/recruit editor; reset progress; mission log tools; module folder path.

## GM toolbar
Refresh notices (re-rolls the posted missions; parties that are out keep theirs), Lock to scene (anchors the board to the map so it pans and zooms with it; Shift+Alt+L toggles), Restore notices, Settings, Open on this scene, Level up all.

## Macros
`game.modules.get("dispatch-minigame").api` provides `open()`, `settings()`, `openLog()`, `setScene(id)`, `unlock()` and `reset()`.

## Notes
- A GM must be online for players' recruit, deploy and train requests.
- Fonts load from Google Fonts; offline they fall back to Palatino/Georgia.

- **Reward percentage** (setting): the share of a mission's posted gold the players receive after a success (default 100%). XP is not affected.

- **XP:** every hero in a successful party gains the mission's XP (x2 on a critical success). A party with empty slots earns more each: x1.5 for one empty slot, x2 for two, x2.5 for three and x5 for four. Total XP is shown on the hero's stat card and can be edited in the settings hero table.

- **Auto level-up:** heroes level up on their own at 250 / 950 / 2950 / 7700 total XP (levels 2-5), gaining the usual stat points to spend. At 17500 total XP a hero may choose a second proficiency from the hero's stat card (GM approval follows the approvals setting). Both proficiencies count for hidden-skill advantage.

- **Group Loot:** the gold from each successful mission (after the gold percentage) is added to the actor chosen in the **Gold goes to** setting (default `Group Loot`; any group or character with a gold field). The success message names the **Gold earner name** setting (default Trollskull Manor), for example: "Each hero gains 70 XP; Trollskull Manor earned 3 gp with its 20% cut." If no such actor exists the message says so.

- **Add recruits** (GM toolbar): asks for a number from 1 to 5 and puts that many random heroes (not recruited and not yet offered) on the Recruits roster.
- **Stat cap:** no stat can go above 20. If a hero's stats run out of room, the level-up card only asks for the points that fit.

- **Starting state (new worlds):** only Thorin is recruited, no heroes are offered for recruiting (use Add recruits or the Available checkboxes), and only tier 0 quests are visible (turn on other tiers in Settings).
