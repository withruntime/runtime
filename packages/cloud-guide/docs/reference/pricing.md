# Pricing reference

Every price, plan and limit as billing charges it, generated from the price card (version 2.0, settled 2026-11-01). Memory and storage are measured in GiB (2^30 bytes); traffic and data in GB (10^9 bytes). A month is 30 days.

## Usage prices

| Meter | Price | Measured |
| --- | --- | --- |
| **Compute** | | |
| CPU | $0.03 per active vCPU-hour | Core-microseconds used, no less than 0.1 vCPU while running |
| Memory | $0.008 per GiB-hour | MiB reserved |
| Requests | $0.20 per million | Requests |
| CI/CD minutes | $0.001 per vCPU-minute, 4 GiB each | VCPU-microseconds a check machine runs, by the second, a vCPU for every 4 GiB of its memory if that is more |
| **Storage** | | |
| Warm | $0.18 per GiB-month | Bytes stored |
| Standard | $0.10 per GiB-month | Bytes stored |
| Cold | $0.02 per GiB-month | Bytes stored |
| **Network** | | |
| Outbound traffic | $0.03 per GB | Bytes sent |
| WireGuard tunnel | $5 a month, 16 devices | Tunnels held |

CPU is billed on the vCPU time a machine uses, and at least 0.1 vCPU while it runs.

## Plans

| | Pro | Growth | Scale | Enterprise |
| --- | --- | --- | --- | --- |
| Monthly fee | $25 | $99 | $499 | Yearly only |
| Yearly fee | $250 | $990 | $4,990 | $24,990 |
| Usage included each month | $25 | $110 | $575 | $3,000 |
| Support | Support agent | Support agent | Shared Slack channel | Private Slack channel |
| Custom roles, keys held to one project, grants narrower than the organization | None | Yes | Yes | Yes |
| Running vCPU | 100 | 250 | 500 | Custom |
| Running memory (GiB) | 200 | 500 | 1,024 | Custom |
| Machine vCPU min | 1 | 1 | 1 | 1 |
| Machine memory (GiB) min | 1 | 1 | 1 | 1 |
| Machine vCPU | 8 | 16 | 32 | Custom |
| Machine memory (GiB) | 32 | 64 | 96 | Custom |
| New machines per second | 20 | 50 | 100 | Custom |
| Fast storage (GiB) | 500 | 2,048 | 5,120 | Custom |
| Cold storage (GiB) | 10,240 | 51,200 | 256,000 | Custom |
| Restore days | 7 | 14 | 30 | 90 |
| Bucket recovery days | 7 | 7 | 7 | 7 |
| Log days | 30 | 90 | 365 | Custom |
| Messages per second | 10,000 | 50,000 | 250,000 | Custom |
| Requests per minute, each key (at least) | 12,000 | 30,000 | 60,000 | Custom |
| Custom domains | 50 | Unlimited | Unlimited | Unlimited |
| Audit log days | None | None | 365 | 2,555 |

A key may always make at least its plan's requests per minute, in bursts of up to 4 seconds' worth. A request refused for its rate is answered 429 `rate_limited`, with `Retry-After` and the `RateLimit-*` headers saying when to send it again.

## Trial

A new account starts on a 7-day Pro trial with $5 of usage. During the trial, at most 5 new machines start a second.

## How usage is paid

Usage is paid from the plan's included usage first, then from credit, then by the card. Usage past what the plan includes is charged before the period ends each time it reaches the next step, once the charge before is paid: $50, $100, $250, $500, then every $1,000. The rest is charged with the next plan fee.
