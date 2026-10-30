Hero portraits go here.

In data/heroes.json set a hero's "img" to just the file name, for example:

    "img": "thorin.png"

and the module will load data/portraits/thorin.png. Square images around 200x200 look best.
Paths that start with icons/, modules/, worlds/, systems/, http or / are used exactly as written,
so you can still point at any image Foundry can reach. If an image fails to load, a default silhouette is shown.
