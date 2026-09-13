#!/usr/bin/perl
use strict;
use warnings;
use POSIX qw(strftime);

# Read-only CGI status page. Run as the existing web-server user; no sudo needed.
# Only fixed systemd units are queried. No credentials, journals or email data
# are read. Source-level queue details remain available through ingest/cli.js.
$ENV{PATH} = '/usr/bin:/bin';
$ENV{LC_ALL} = 'C';
$ENV{SYSTEMD_COLORS} = '0';
delete @ENV{qw(ENV BASH_ENV CDPATH SYSTEMD_HOST SYSTEMD_MACHINE)};

my @units = (
    ['knowledge-agent.service', 'daemon'],
    ['knowledge-sync.timer', 'trigger'],
    ['knowledge-sync.service', 'oneshot'],
    ['knowledge-http-puller.path', 'trigger'],
    ['knowledge-http-puller.service', 'oneshot'],
    ['knowledge-http-puller-cleanup.timer', 'trigger'],
    ['knowledge-http-puller-cleanup.service', 'oneshot'],
    ['knowledge-ingest.timer', 'trigger'],
    ['knowledge-ingest.service', 'oneshot'],
);
my @properties = qw(LoadState Description ActiveState SubState UnitFileState
    Result ExecMainCode ExecMainStatus MainPID InactiveExitTimestamp
    ExecMainExitTimestamp MemoryCurrent);
my %states;
for my $entry (@units) {
    my ($unit) = @$entry;
    my ($output, $ok) = systemctl('show', $unit, '--no-pager',
        map { '--property=' . $_ } @properties);
    my %p = map { split /=/, $_, 2 } grep { /^[A-Za-z]+=/ } split /\n/, $output;
    $p{query_ok} = $ok;
    $states{$unit} = \%p;
}

print "Content-Type: text/html; charset=UTF-8\r\n";
print "Cache-Control: no-store\r\n";
print "X-Content-Type-Options: nosniff\r\n\r\n";
my $generated = esc(strftime('%Y-%m-%d %H:%M:%S %Z', localtime));
print <<"HTML";
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Knowledge Agent Status</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<style>
:root { color-scheme:dark; --bg:#0f1115; --panel:#171a21; --text:#f2f4f8; --muted:#9aa4b2; --border:#2b3240; }
* { box-sizing:border-box; }
body { margin:0; background:radial-gradient(circle at top left,#17382b,transparent 34rem),var(--bg); color:var(--text); font:15px system-ui,sans-serif; padding:32px; }
main { max-width:1100px; margin:auto; }
h1 { margin:0 0 8px; font-size:clamp(28px,4vw,44px); }
.subtitle, .desc, footer, .note { color:var(--muted); }
.note { line-height:1.6; }
.grid { display:grid; gap:14px; margin-top:22px; }
.card { border:1px solid var(--border); background:linear-gradient(180deg,var(--panel),#1f2430); border-radius:8px; padding:18px; }
.row { display:grid; grid-template-columns:1.5fr .8fr .8fr 1.4fr; gap:16px; align-items:start; }
.unit { font-weight:700; overflow-wrap:anywhere; }
.desc, .raw { margin-top:6px; font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
.label { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; margin-bottom:8px; }
.pill { display:inline-block; border:1px solid currentColor; border-radius:999px; padding:6px 10px; font-weight:700; font-size:13px; }
.ok { color:#45d483; } .warn { color:#f0c35b; } .bad { color:#ff5f6d; } .unknown { color:#8ea0ff; }
.detail { font-size:13px; line-height:1.6; overflow-wrap:anywhere; }
footer { font-size:12px; margin-top:18px; }
\@media(max-width:800px) { body { padding:18px; } .row { grid-template-columns:1fr; } }
</style></head><body><main>
<h1>Knowledge Agent Status</h1>
<div class="subtitle">Systemd snapshot: $generated &middot; refreshes every 30 seconds</div>
<p class="note">The ingestion timer checks for due sources; it does not start overlapping batches.
Migrated Gmail defaults to 10 minutes after the previous batch finishes (source settings may override this).
An executing one-shot batch normally appears as <strong>activating / start</strong>.
An idle one-shot service is normal. This page shows service health, not individual item progress.</p>
<section class="grid">
HTML

for my $entry (@units) {
    my ($unit, $kind) = @$entry;
    my $p = $states{$unit};
    my ($label, $class) = health($p, $kind);
    my $enabled = $p->{UnitFileState} || 'unknown';
    my ($boot, $boot_class) = boot_state($enabled, $kind);
    my @details;
    if ($kind eq 'legacy') {
        push @details, 'Retired: replaced by knowledge-ingest.';
    } elsif ($unit =~ /\.timer$/) {
        my $service = $unit;
        $service =~ s/\.timer$/.service/;
        my $s = $states{$service} || {};
        push @details, 'Next check: ' . next_check($unit, $p, $s);
        push @details, 'Checks source due times; not a per-item schedule.' if $unit eq 'knowledge-ingest.timer';
    } elsif ($unit =~ /\.path$/) {
        push @details, 'Triggered by watched filesystem changes.';
    } else {
        my $busy = ($p->{ActiveState} || '') =~ /^(active|activating|deactivating)$/;
        push @details, 'Started: ' . $p->{InactiveExitTimestamp}
            if $busy && meaningful($p->{InactiveExitTimestamp});
        push @details, 'Last exit: ' . $p->{ExecMainExitTimestamp}
            if meaningful($p->{ExecMainExitTimestamp});
        # Result is not the outcome of the unfinished batch.
        if ($busy && $kind eq 'oneshot') {
            push @details, 'Batch outcome: pending completion';
        } elsif (meaningful($p->{Result})) {
            push @details, 'Recorded result: ' . $p->{Result};
        }
        push @details, 'Exit status: ' . $p->{ExecMainStatus}
            if !$busy && meaningful($p->{ExecMainExitTimestamp}) && defined $p->{ExecMainStatus};
        push @details, 'PID: ' . $p->{MainPID} if ($p->{MainPID} || 0) > 0;
        my $mem = $p->{MemoryCurrent} || '';
        push @details, sprintf('Memory: %.1f MiB', $mem / 1048576)
            if $busy && $mem =~ /^\d+$/ && $mem < 18446744073709551615;
    }
    push @details, 'Status query unavailable.' unless $p->{query_ok} || ($p->{LoadState} || '') eq 'not-found';
    my $details = join '<br>', map { esc($_) } @details;
    my $raw = join ' / ', map { $p->{$_} || 'unknown' } qw(ActiveState SubState);
    print '<article class="card"><div class="row"><div><div class="unit">', esc($unit),
        '</div><div class="desc">', esc($p->{Description} || $unit),
        '</div></div><div><div class="label">Health</div><span class="pill ', $class, '">', esc($label),
        '</span><div class="raw">', esc($raw),
        '</div></div><div><div class="label">Startup</div><span class="pill ', $boot_class, '">', esc($boot),
        '</span><div class="raw">', esc($enabled),
        '</div></div><div><div class="label">Details</div><div class="detail">', $details,
        '</div></div></div></article>', "\n";
}
print '</section><footer>Read-only monitoring. No services are started or stopped. ',
    scalar(@units), ' units checked. Queue counts and failures: sudo -u knowledge node /opt/knowledge-agent/ingest/cli.js status',
    '</footer></main></body></html>', "\n";

sub systemctl {
    # Bound each command, disable paging, and avoid shell interpolation.
    my @args = @_;
    open my $fh, '-|', '/usr/bin/timeout', '5s', '/usr/bin/systemctl', @args
        or return ('', 0);
    local $/;
    my $output = <$fh> // '';
    my $ok = close $fh;
    return ($output, $ok ? 1 : 0);
}

sub health {
    my ($p, $kind) = @_;
    my $load = $p->{LoadState} || '';
    my $active = $p->{ActiveState} || '';
    my $sub = $p->{SubState} || '';
    if ($load eq 'not-found') {
        return $kind eq 'legacy' ? ('Not installed', 'ok') : ('Missing unit', 'bad');
    }
    return ('Unknown', 'unknown') unless $p->{query_ok};
    return ('Load error', 'bad') unless $load eq 'loaded';
    if ($kind eq 'legacy') {
        return ('Legacy still running', 'warn') if $active =~ /^(active|activating|deactivating)$/;
        return ('Legacy still enabled', 'warn') if ($p->{UnitFileState} || '') =~ /^(enabled|linked|alias)/;
        return ('Retired', 'ok');
    }
    return ('Failed', 'bad') if $active eq 'failed';
    return ('Stopping', 'warn') if $active eq 'deactivating';
    if ($kind eq 'oneshot') {
        return ('Running batch', 'ok') if $active eq 'activating' && $sub =~ /^start(?:-pre|-post)?$/;
        return ('Running', 'ok') if $active eq 'active' && $sub eq 'running';
        if ($active eq 'inactive' || ($active eq 'active' && $sub eq 'exited')) {
            return ('Last run failed', 'bad') if meaningful($p->{Result}) && $p->{Result} ne 'success';
            return ('Idle', 'ok');
        }
    }
    return ('Active', 'ok') if $active eq 'active';
    return ('Starting', 'warn') if $active eq 'activating';
    return ('Stopped', 'warn') if $active eq 'inactive';
    return ($active || 'Unknown', 'unknown');
}

sub boot_state {
    my ($enabled, $kind) = @_;
    return ('Retired', 'ok') if $kind eq 'legacy' && $enabled =~ /^(disabled|masked|unknown)$/;
    return ('Enabled', $kind eq 'legacy' ? 'warn' : 'ok') if $enabled eq 'enabled';
    return ('Until reboot', 'warn') if $enabled eq 'enabled-runtime';
    return ('Via trigger', 'ok') if $enabled eq 'static' && $kind eq 'oneshot';
    return ('Static', 'unknown') if $enabled eq 'static';
    return ('Disabled', 'warn') if $enabled eq 'disabled';
    return ('Masked', 'warn') if $enabled =~ /^masked/;
    return ($enabled, 'unknown');
}

sub next_check {
    my ($unit, $timer, $service) = @_;
    return 'Timer is not active' unless ($timer->{ActiveState} || '') eq 'active';
    return 'Batch running; no overlapping start' if ($service->{ActiveState} || '') =~ /^(active|activating|deactivating)$/;
    my ($output, $ok) = systemctl('list-timers', '--all', '--no-pager', '--no-legend', '--full', $unit);
    return 'Unavailable' unless $ok;
    # NEXT is four tokens (weekday, date, time, zone), not five. Do not
    # accidentally append the first token of the LEFT column as before.
    for my $line (split /\n/, $output) {
        next unless $line =~ /\Q$unit\E/;
        return $1 if $line =~ /^\s*(\S+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\S+)\s/;
        return 'No next check reported' if $line =~ /^\s*(?:n\/a|-)\s/;
    }
    return 'Unavailable';
}

sub meaningful {
    return defined($_[0]) && $_[0] ne '' && $_[0] ne 'n/a';
}

sub esc {
    my ($s) = @_;
    $s //= '';
    $s =~ s/&/&amp;/g;
    $s =~ s/</&lt;/g;
    $s =~ s/>/&gt;/g;
    $s =~ s/"/&quot;/g;
    return $s;
}
