| Concurrent groups | Client samples | Settle median | Settle / 1 | Query-wave wall median | Wave / 1 | Query-lock hold median | Hold / 1 | Timed query processing | Tracker hydration |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3 | 1263.0 ms | 1.00x | 818.2 ms | 1.00x | 841.6 ms | 1.00x | 730.6 ms | 537.7 ms |
| 2 | 6 | 2035.5 ms | 1.61x | 1430.8 ms | 1.75x | 1488.3 ms | 1.77x | 642.1 ms | 464.8 ms |
| 4 | 12 | 3679.0 ms | 2.91x | 2784.9 ms | 3.40x | 2840.6 ms | 3.38x | 632.8 ms | 450.3 ms |
| 8 | 24 | 7181.0 ms | 5.69x | 5616.2 ms | 6.86x | 5674.7 ms | 6.74x | 646.0 ms | 448.2 ms |
| 16 | 32 | 14746.0 ms | 11.68x | 12080.2 ms | 14.76x | 12178.3 ms | 14.47x | 685.0 ms | 484.8 ms |

wave: n=3, first median 1.424s, settle median 1.425s, first range 1.326-1.467s, settle range 1.327-1.468s
wave-control: n=3, first median 0.659s, settle median 0.660s, first range 0.567-0.659s, settle range 0.568-0.660s
two-tier: n=3, first median 0.571s, settle median 1.331s, first range 0.560-0.577s, settle range 1.318-1.397s
staggered: n=3, first median 0.182s, settle median 1.520s, first range 0.153-0.209s, settle range 1.439-1.625s
