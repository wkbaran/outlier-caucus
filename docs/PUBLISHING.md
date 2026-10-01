# Publishing

`report:html` writes a static site to `output/web/`:

```
output/web/
  index.html            forwards to the newest report
  archive.html          every report, newest first
  manifest.json         run history: dates, counts, what was new
  latest.json           the newest brief for agents (see README)
  favicon.ico           icons for browsers and iOS home screens
  apple-touch-icon.png  (regenerate with scripts/make-icons.mjs)
  2026-09-24/
    report.html         the daily briefing
    member-<name>.html  one page per member
    party-<name>.html   Republicans, Democrats, Independents
    brief.json          this run's brief for agents
```

`index.html`, `archive.html`, `manifest.json` and `latest.json` keep the same name every run, so they're uploaded with `Cache-Control: no-cache`.

Any static host works. The rest of this page covers the setup this repo ships with: S3 and CloudFront on AWS, and a daily scheduled run.

## AWS hosting

`cloudformation.yaml` creates a private S3 bucket, a CloudFront distribution in front of it, an IAM user that can only publish, and optionally an ACM certificate and Route 53 record for your own domain. Deploy it to `us-east-1`, because CloudFront only uses certificates from there.

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name congress-trades \
  --template-file cloudformation.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides BucketName=<globally-unique-bucket-name>
```

For your own domain, add `CustomDomain=trades.example.com HostedZoneId=<route53-zone-id>` to the overrides.

Copy the stack's outputs into `.env`:

```
S3_BUCKET=<BucketName output>
AWS_REGION=<Region output>
AWS_ACCESS_KEY_ID=<AccessKeyId output>
AWS_SECRET_ACCESS_KEY=<SecretAccessKey output>
CLOUDFRONT_DISTRIBUTION_ID=<DistributionId output>
```

The secret key is only shown in the outputs of the first deploy. If you lose it, rotate the key in IAM.

Then publish:

```bash
node --env-file=.env dist/index.js report:html --publish
```

That fetches new filings, reruns the analysis, regenerates the site, syncs `output/web` to the bucket (uploading changed files and deleting ones that are gone), and clears the CloudFront cache. Useful variations:

| Command | Does |
|---|---|
| `report:html --publish --skip-unchanged` | Stops early when the fetch found nothing new. What the scheduled run uses |
| `report:html --render-only --publish` | Rebuilds today's pages from the last saved analysis, after a design change say |
| `report:html --rebuild-index --publish` | Rebuilds only `index.html` and `archive.html` |
| `report:html --no-fetch-trades --date 2026-09-29 --publish` | Reruns the analysis on the stored trades and replaces that day's report, after correcting data say. What counts as new is still measured from the report before it |

## Daily run on Windows

`run-and-publish.ps1` runs `report:html --publish --skip-unchanged` and logs to `logs\outlier-caucus-YYYY-MM-DD.log`. Filings are only posted on business days, so schedule it Monday to Friday. In PowerShell as Administrator, adjusting the path and time:

```powershell
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument '-NonInteractive -ExecutionPolicy Bypass -File "C:\path\to\outlier-caucus\run-and-publish.ps1"' `
  -WorkingDirectory "C:\path\to\outlier-caucus"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "7:00AM"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable

Register-ScheduledTask -TaskName "Outlier Caucus - Daily Report" `
  -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest
```

`-StartWhenAvailable` runs it as soon as possible if the computer was off at the scheduled time.

## Docker

`docker/Dockerfile` builds the CLI into a Node 22 image that runs the daily schedule itself: [supercronic](https://github.com/aptible/supercronic) starts `report:html --publish --skip-unchanged` at 07:00 Mountain, Monday to Friday, as set in `docker/crontab`. The container stays up (`restart: unless-stopped`), so `docker ps` shows it and `docker logs` has every run. To change the schedule, edit `docker/crontab` and rebuild. From the repo root:

```bash
docker compose -f docker/compose.yaml up -d --build      # build and start the scheduled container
docker logs -f outlier-caucus                            # follow the logs
docker exec outlier-caucus node dist/index.js report:html --publish --skip-unchanged   # run it now
docker exec outlier-caucus node dist/index.js ocr:catchup --limit 5                    # any other command
```

- **Settings** come from the repo's `.env` if there is one, then `docker/.env` if there is one, which wins. Compose reads both on the machine you run it from.
- **Data** persists across runs: `data/`, `reports/`, `output/`, `formatted-reports/` and `logs/` are mounted from the repo, so the container and a native install share the same cache.
- **Ollama**: `OLLAMA_URL` defaults to `http://host.docker.internal:11434`, the Ollama on the Docker host (this works on Linux too). Set `OLLAMA_URL` and `OLLAMA_API_KEY` in your shell or in `docker/.env`, not the repo's `.env`. Compose gives those priority because the repo's `.env` usually points at `localhost`, which inside a container is the container itself.
- A run missed while the container was stopped isn't made up. The next one fetches everything since the last.

Without compose:

```bash
docker build -f docker/Dockerfile -t outlier-caucus .
docker run -d --name outlier-caucus --restart unless-stopped --env-file .env \
  -e OLLAMA_URL=http://host.docker.internal:11434 \
  -v "$PWD/data:/app/data" -v "$PWD/reports:/app/reports" -v "$PWD/output:/app/output" \
  -v "$PWD/formatted-reports:/app/formatted-reports" -v "$PWD/logs:/app/logs" \
  outlier-caucus
```

### Deploying to a remote Docker host

Compose can drive a remote daemon, so nothing but the state directory has to exist on the host. From the repo root:

```bash
export DOCKER_HOST=ssh://user@host
docker compose -f docker/compose.yaml up -d --build      # builds on the host, then starts the container
docker compose -f docker/compose.yaml logs -f
```

1. **Copy the state to the host first.** Put `data/`, `output/`, `reports/` and `logs/` in one directory there. `output/web` matters most: `--publish` deletes bucket objects that aren't in it, so a host that starts empty would wipe the archive on its first publish. Before the first publish, compare `output/web` with the bucket (`aws s3 ls --recursive` against `find output/web -type f`) and expect nothing to be deleted. Of `reports/` only the newest file is needed, for `--render-only`.
2. **Write `docker/.env` on the machine you deploy from** (it's gitignored). It holds the settings, including secrets, and where the state lives on the host:

   ```
   STATE_DIR=/var/home/core/outlier-caucus
   OLLAMA_URL=http://<ollama-host>:11434
   SEC_USER_AGENT=Your Name you@example.com
   S3_BUCKET=...  AWS_REGION=...  CLOUDFRONT_DISTRIBUTION_ID=...  AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...   # one per line
   ```

   `STATE_DIR` must be an absolute path on the host. The container uses the host's DNS, so a LAN name works for `OLLAMA_URL`. Use the publish-only key from the CloudFormation stack, not an admin profile.
3. Run the `docker compose ... up -d --build` above. On SELinux hosts such as Fedora CoreOS the `:z` on the volumes is needed, and is already in the compose file.
