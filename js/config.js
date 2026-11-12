/* ================================================================
   CONFIG — edit this file to change teams, owners or colors.

   `id` is the MLB team id:
   108 LAA  109 AZ   110 BAL  111 BOS  112 CHC  113 CIN  114 CLE
   115 COL  116 DET  117 HOU  118 KC   119 LAD  120 WSH  121 NYM
   133 ATH  134 PIT  135 SD   136 SEA  137 SF   138 STL  139 TB
   140 TEX  141 TOR  142 MIN  143 PHI  144 ATL  145 CWS  146 MIA
   147 NYY  158 MIL

   g1/g2    card gradient    accent  record color    stat  non-leader stat color
   line     color of the team's line in the season trend chart
   NOTE: keep `stat` away from gold (#ffd23c) — gold is reserved for category leaders.
================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MLBConfig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    TEAMS: [
      { abbr: 'TB',  id: 139, owner: "Dad's Team",    name: 'Tampa Bay Rays',    g1: '#0a2351', g2: '#143468', accent: '#8fbce6', stat: '#8fbce6', line: '#3D95D0' },
      { abbr: 'MIL', id: 158, owner: "Mom's Team",    name: 'Milwaukee Brewers', g1: '#12284b', g2: '#1a3a6e', accent: '#ffc52f', stat: '#cfdcff', line: '#BF8400' },
      { abbr: 'TOR', id: 141, owner: "Brady's Team",  name: 'Toronto Blue Jays', g1: '#134a8e', g2: '#1a62bc', accent: '#a8d4ff', stat: '#a8d4ff', line: '#C068A2' },
      { abbr: 'CIN', id: 113, owner: "Deacon's Team", name: 'Cincinnati Reds',   g1: '#8b0014', g2: '#c6011f', accent: '#ffffff', stat: '#ffcdd2', line: '#D4531A' },
    ],

    // MLB's public stats API.
    MLB_BASE: 'https://statsapi.mlb.com/api/v1',

    // Where the scheduled GitHub Action publishes its data (the "data" branch of this repo).
    // The page reads this first and falls back to calling MLB directly. Set to '' to always call MLB directly.
    DATA_BASE: 'https://raw.githubusercontent.com/levimcneely-cmyk/familymlbtracker/data/',
  };
});
