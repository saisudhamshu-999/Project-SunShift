"""Machine-learning corrections to the weather inputs.

- solar: corrects the day-ahead solar radiation forecast and gives a cautious (P10),
  likely (P50) and optimistic (P90) curve; the optimiser plans on P50 and steers pumping
  away from hours where even the cautious curve leaves the pumps on grid power.
- rain: turns the day-ahead rain forecast into a calibrated probability of meaningful
  rain (at least ``policy.rain_min_mm`` in the 30-hour look-ahead), used to defer irrigation.

Both are trained on Open-Meteo's archived day-ahead forecasts against ERA5 reanalysis
(``python -m app.ml.train``) and evaluated on a held-out final year. Features are built
by ``features.py`` for training and live planning alike, so the two cannot drift apart.
"""
