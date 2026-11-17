# Pricing reference

Every price, plan and limit as billing charges it, generated from the price card (version 2.0, settled 2026-11-01). Memory and storage are measured in GiB (2^30 bytes); traffic and data in GB (10^9 bytes). A month is 30 days.

## Usage prices

| Meter | Price | Measured |
| --- | --- | --- |
| **Compute** | | |
| CPU | $0.03 per busy vCPU-hour | Core-microseconds used, no less than 0.1 vCPU while running |
| Memory | $0.008 per GB-hour | MiB reserved |
| Function calls | $0.20 per million | Calls |
| CI/CD | $0.001 per vCPU-minute, 4 GiB each | VCPU-microseconds a check machine runs, by the second, a vCPU for every 4 GiB of its memory if that is more |
| **Storage** | | |
| Warm | $0.18 per GB-month | Bytes stored |
| Standard | $0.10 per GB-month | Bytes stored |
| Cold | $0.02 per GB-month | Bytes stored |
| **Network** | | |
| Traffic out | $0.03 per GB | Bytes sent |
| Dedicated IPv4 | $5 per address, a month | Addresses held |
| WireGuard tunnel | $5 a month, 16 devices | Tunnels held |

CPU is billed on the vCPU time a machine uses, and at least 0.1 vCPU while it runs.

## Plans

| | Pro | Growth | Scale | Enterprise |
| --- | --- | --- | --- | --- |
| Monthly fee | $25 | $99 | $499 | Yearly only |
| Yearly fee | $250 | $990 | $4,990 | $24,990 |
| Usage included each month | $25 | $110 | $575 | $3,000 |
| Support | Support agent | Support agent | Shared Slack channel | Private Slack channel |
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
| Requests per minute | Unlimited | Unlimited | Unlimited | Custom |
| Custom domains | 50 | Unlimited | Unlimited | Unlimited |
| IPv4 addresses held, each billed | 1 | 3 | 10 | Custom |
| Audit log days | None | None | 365 | 2,555 |

## Trial

A new account starts on a 7-day Pro trial with $5 of usage. During the trial, at most 5 new machines a second.

## Refunds

Pro and Growth fees are refundable for 30 days.
