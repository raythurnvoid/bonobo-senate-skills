# Bonobo Senate skills

Agent skills for Bonobo Senate.

| Skill | What it does |
| --- | --- |
| [`press-api`](skills/press-api/SKILL.md) | Use the Bonobo Senate public API from your computer: set up an API key, then upload, list, read, write, make folders, move, copy, and delete files with the `api.mjs` CLI. |

The skills are plain folders with a `SKILL.md` file. Any agent that reads Agent Skills can use them.

## Install

Pick the way that fits your agent. None of them needs an extra package. Use one way per agent: two ways can put two copies of the skill in the same agent, and the `skills` CLI replaces an existing `~/.claude/skills/press-api` link.

### Claude Code

```sh
claude plugin marketplace add raythurnvoid/bonobo-senate-skills
claude plugin install bonobo-senate@bonobo-senate-skills
```

The skill shows up as `bonobo-senate:press-api`.

Update:

```sh
claude plugin marketplace update bonobo-senate-skills
claude plugin update bonobo-senate@bonobo-senate-skills
```

Restart Claude Code after the update.

Or turn on auto-update for this marketplace in `/plugin` > Marketplaces.

### Codex

```sh
codex plugin marketplace add raythurnvoid/bonobo-senate-skills
codex plugin add bonobo-senate@bonobo-senate-skills
```

Codex updates Git marketplaces when it starts.

### GitHub CLI

```sh
gh skill install raythurnvoid/bonobo-senate-skills press-api --agent claude-code --scope user
gh skill install raythurnvoid/bonobo-senate-skills press-api --agent codex --scope user
```

Run the line for each agent you use.

Update: `gh skill update --all`.

### Plain git (any agent)

Clone the repo once, then link the skill folder into your agent's user skills folder.

macOS and Linux:

```sh
git clone https://github.com/raythurnvoid/bonobo-senate-skills.git ~/bonobo-senate-skills
mkdir -p ~/.claude/skills
ln -s ~/bonobo-senate-skills/skills/press-api ~/.claude/skills/press-api
```

Windows (Command Prompt):

```bat
git clone https://github.com/raythurnvoid/bonobo-senate-skills.git %USERPROFILE%\bonobo-senate-skills
if not exist %USERPROFILE%\.claude\skills mkdir %USERPROFILE%\.claude\skills
mklink /J %USERPROFILE%\.claude\skills\press-api %USERPROFILE%\bonobo-senate-skills\skills\press-api
```

Codex reads user skills from `~/.agents/skills`; link the folder there too if you use Codex. Codex blocks the network in its default sandbox, so turn network access on for sessions that call the API.

Update: `git pull` in the clone.

### skills CLI (optional)

```sh
pnpm dlx skills add raythurnvoid/bonobo-senate-skills -g -s press-api -a claude-code -a codex -y
```

Name your agents with `-a`. Without it, `-y` tries every agent the CLI knows, and some of them cannot take a user-level skill.

Update: `pnpm dlx skills update -g`.

## API key

The skill never ships a key. On first use it asks you to create one on the API keys page of your workspace. Then you save it in `~/.config/bonobo-senate/credentials.json` with the `login` command. The script's place depends on how you installed the skill, so run `status` first: with no key, it prints the exact `login` command with the full path. For example, after the plain git install:

```sh
node ~/bonobo-senate-skills/skills/press-api/scripts/api.mjs status
```

Every install on the same computer uses the same key file. Updates and reinstalls do not touch it. See [setup](skills/press-api/references/setup.md).
