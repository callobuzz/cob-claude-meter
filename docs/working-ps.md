PS C:\Users\SV> $cutoff = (Get-Date).AddDays(-30)
PS C:\Users\SV>
PS C:\Users\SV> $inputTokens = 0L
PS C:\Users\SV> $outputTokens = 0L
PS C:\Users\SV> $cacheReadTokens = 0L
PS C:\Users\SV> $cacheCreateTokens = 0L
PS C:\Users\SV> $matchedEntries = 0L
PS C:\Users\SV> $filesScanned = 0L
PS C:\Users\SV>
PS C:\Users\SV> Get-ChildItem "$HOME\.claude\projects" -Recurse -Filter *.jsonl | ForEach-Object {
>>     $filesScanned++
>>
>>     Get-Content $_.FullName | ForEach-Object {
>>         try {
>>             $json = $_ | ConvertFrom-Json
>>
>>             if ($json.type -eq "assistant" -and $json.message -and $json.message.usage -and $json.timestamp) {
>>                 $ts = [datetime]$json.timestamp
>>
>>                 if ($ts -ge $cutoff) {
>>                     $u = $json.message.usage
>>
>>                     $inputTokens += [int64]($u.input_tokens -as [int64])
>>                     $outputTokens += [int64]($u.output_tokens -as [int64])
>>                     $cacheReadTokens += [int64]($u.cache_read_input_tokens -as [int64])
>>                     $cacheCreateTokens += [int64]($u.cache_creation_input_tokens -as [int64])
>>                     $matchedEntries++
>>                 }
>>             }
>>         } catch {}
>>     }
>> }
PS C:\Users\SV>
PS C:\Users\SV> # Claude Opus 4.6 pricing (USD per million tokens)
PS C:\Users\SV> $priceInputPerMTok = 5.00
PS C:\Users\SV> $priceOutputPerMTok = 25.00
PS C:\Users\SV> $priceCacheReadPerMTok = 0.50
PS C:\Users\SV> $priceCacheWrite5mPerMTok = 6.25
PS C:\Users\SV> $priceCacheWrite1hPerMTok = 10.00
PS C:\Users\SV>
PS C:\Users\SV> function CostFromTokens($tokens, $pricePerMTok) {
>>     return [math]::Round(($tokens / 1000000.0) * $pricePerMTok, 4)
>> }
PS C:\Users\SV>
PS C:\Users\SV> $costInput = CostFromTokens $inputTokens $priceInputPerMTok
PS C:\Users\SV> $costOutput = CostFromTokens $outputTokens $priceOutputPerMTok
PS C:\Users\SV> $costCacheRead = CostFromTokens $cacheReadTokens $priceCacheReadPerMTok
PS C:\Users\SV> $costCacheWrite5m = CostFromTokens $cacheCreateTokens $priceCacheWrite5mPerMTok
PS C:\Users\SV> $costCacheWrite1h = CostFromTokens $cacheCreateTokens $priceCacheWrite1hPerMTok
PS C:\Users\SV>
PS C:\Users\SV> $freshTotalTokens = $inputTokens + $outputTokens
PS C:\Users\SV> $fullTotalTokens = $inputTokens + $outputTokens + $cacheReadTokens + $cacheCreateTokens
PS C:\Users\SV>
PS C:\Users\SV> $estimateLow = [math]::Round(($costInput + $costOutput + $costCacheRead + $costCacheWrite5m), 4)
PS C:\Users\SV> $estimateHigh = [math]::Round(($costInput + $costOutput + $costCacheRead + $costCacheWrite1h), 4)
PS C:\Users\SV>
PS C:\Users\SV> $result = [ordered]@{
>>     period = @{
>>         label = "last_30_days"
>>         start = $cutoff.ToString("o")
>>         end = (Get-Date).ToString("o")
>>     }
>>     totals = @{
>>         input_tokens = $inputTokens
>>         output_tokens = $outputTokens
>>         cache_read_input_tokens = $cacheReadTokens
>>         cache_creation_input_tokens = $cacheCreateTokens
>>         fresh_total_tokens = $freshTotalTokens
>>         full_total_tokens = $fullTotalTokens
>>         matched_entries = $matchedEntries
>>         files_scanned = $filesScanned
>>     }
>>     pricing_assumption = @{
>>         model = "Claude Opus 4.6"
>>         currency = "USD"
>>         rates_per_million_tokens = @{
>>             input = $priceInputPerMTok
>>             output = $priceOutputPerMTok
>>             cache_read_input = $priceCacheReadPerMTok
>>             cache_creation_input_5m = $priceCacheWrite5mPerMTok
>>             cache_creation_input_1h = $priceCacheWrite1hPerMTok
>>         }
>>         note = "cache_creation_input_tokens cannot usually be separated into 5m vs 1h from local Claude Code logs alone"
>>     }
>>     cost_estimate_usd = @{
>>         input_cost = $costInput
>>         output_cost = $costOutput
>>         cache_read_cost = $costCacheRead
>>         cache_creation_cost_if_5m = $costCacheWrite5m
>>         cache_creation_cost_if_1h = $costCacheWrite1h
>>         estimated_total_if_5m_cache_write = $estimateLow
>>         estimated_total_if_1h_cache_write = $estimateHigh
>>     }
>> }
PS C:\Users\SV>
PS C:\Users\SV> $result | ConvertTo-Json -Depth 6
{
    "period":  {
                   "label":  "last_30_days",
                   "end":  "2026-03-22T02:07:43.6365998+05:30",
                   "start":  "2026-02-20T02:06:41.6772191+05:30"
               },
    "totals":  {
                   "output_tokens":  11598636,
                   "input_tokens":  5896108,
                   "files_scanned":  2568,
                   "cache_creation_input_tokens":  483414090,
                   "full_total_tokens":  8767865544,
                   "cache_read_input_tokens":  8266956710,
                   "fresh_total_tokens":  17494744,
                   "matched_entries":  106461
               },
    "pricing_assumption":  {
                               "currency":  "USD",
                               "rates_per_million_tokens":  {
                                                                "input":  5,
                                                                "cache_creation_input_1h":  10,
                                                                "cache_creation_input_5m":  6.25,
                                                                "cache_read_input":  0.5,
                                                                "output":  25
                                                            },
                               "model":  "Claude Opus 4.6",
                               "note":  "cache_creation_input_tokens cannot usually be separated into 5m vs 1h from local Claude Code logs alone"
                           },
    "cost_estimate_usd":  {
                              "cache_creation_cost_if_1h":  4834.1409,
                              "estimated_total_if_1h_cache_write":  9287.0657,
                              "estimated_total_if_5m_cache_write":  7474.2629,
                              "output_cost":  289.9659,
                              "cache_read_cost":  4133.4784,
                              "input_cost":  29.4805,
                              "cache_creation_cost_if_5m":  3021.3381
                          }
}
PS C:\Users\SV>
