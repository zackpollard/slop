"""a1-pvlib-vectors.py — dev-only: build the pvlib reference fixture for the solar-sun / solar-pv tests.

Not shipped and not run by CI. Needs pvlib 0.16 (the research venv). Reads the verifier's random
vectors (pvlib-random-vectors.json, seed 20261005), keeps the first 200 transposition cases and adds
the isotropic / Hay-Davies / Perez POA totals pvlib gives for exactly those inputs, plus sun-position,
IAM, Faiman, PVWatts, inverter, airmass, ETR and clear-sky spot values.

Usage:
  python a1-pvlib-vectors.py <research_dir> [out_json]
"""
import json
import sys

import numpy as np
import pandas as pd
import pvlib
from pvlib import atmosphere, iam, inverter, irradiance, pvsystem, temperature

import os

RESEARCH = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('SOLAR_RESEARCH_DIR')
if not RESEARCH:
    sys.exit('usage: python a1-pvlib-vectors.py <research_dir> [out_json]  (or set SOLAR_RESEARCH_DIR)')
OUT = sys.argv[2] if len(sys.argv) > 2 else 'lib/slopnet/__tests__/fixtures/solar/a1-pvlib-vectors.json'
NT = 200

rv = json.load(open(f'{RESEARCH}/verify-pv-physics/pvlib-random-vectors.json'))
tr = {k: np.asarray(v[:NT], float) for k, v in rv['transp'].items()}
zen, azi, tilt, saz = tr['zen'], tr['azi'], tr['tilt'], tr['saz']
dhi, dni, ghi, dni_extra, am = tr['dhi'], tr['dni'], tr['ghi'], tr['dni_extra'], tr['am']

poa = {}
for model in ['isotropic', 'haydavies', 'perez']:
    tot = irradiance.get_total_irradiance(tilt, saz, zen, azi, dni, ghi, dhi, dni_extra=dni_extra, airmass=am,
                                          albedo=0.2, model=model)
    poa[model] = {k: np.asarray(tot[k], float).tolist() for k in ['poa_global', 'poa_direct', 'poa_sky_diffuse', 'poa_ground_diffuse']}
per = irradiance.perez(tilt, saz, dhi, dni, dni_extra, zen, azi, am, model='allsitescomposite1990', return_components=True)

# sun position: verifier's random SPA rows (pressure 1013.25 hPa, 12 C) and the NREL SPA report example
sun = rv['sunpos'][:120]
nrel_t = pd.DatetimeIndex([pd.Timestamp('2003-10-17 19:30:30', tz='UTC')])
nrel = pvlib.solarposition.spa_python(nrel_t, 39.742476, -105.1786, altitude=1830.14, pressure=82000, temperature=11, delta_t=67)

th = rv['thermal']
out = {
    'note': 'pvlib %s; transposition = first %d vectors of research/verify-pv-physics/pvlib-random-vectors.json' % (pvlib.__version__, NT),
    'transp': {
        **{k: v.tolist() for k, v in tr.items() if k in ('zen', 'azi', 'tilt', 'saz', 'dhi', 'dni', 'ghi', 'doy', 'dni_extra', 'am', 'aoi', 'iam_mr')},
        'perez_sky': np.asarray(per['poa_sky_diffuse'], float).tolist(),
        'perez_cs': np.asarray(per['poa_circumsolar'], float).tolist(),
        'perez_iso': np.asarray(per['poa_isotropic'], float).tolist(),
        'perez_hz': np.asarray(per['poa_horizon'], float).tolist(),
        'poa': poa,
    },
    'sunpos_spa': {'note': 'rows [ms, lat, lon, zenithTrue, zenithApparent, azimuth]; spa_python pressure 101325 Pa, 12 C', 'rows': sun},
    'nrel_spa_example': {'ms': int(nrel_t[0].value // 10**6), 'lat': 39.742476, 'lon': -105.1786, 'pressureHpa': 820, 'tempC': 11,
                         'published_zenith': 50.11162, 'published_azimuth': 194.34024,
                         'pvlib_apparent_zenith': float(nrel['apparent_zenith'].iloc[0]), 'pvlib_azimuth': float(nrel['azimuth'].iloc[0])},
    'mrd': rv['mrd'],
    'iam_beam': {str(a): float(iam.martin_ruiz(a, a_r=0.16)) for a in [0, 30, 50, 60, 70, 80, 85, 89, 90, 95]},
    'thermal': {k: th[k][:60] for k in ('G', 'Ta', 'ws', 'tf', 'dc')},
    'inv': {k: rv['inv'][k][:60] for k in ('pdc', 'ac')},
    'airmass': {str(z): float(atmosphere.get_relative_airmass(z, 'kastenyoung1989')) for z in [0, 30, 60, 70, 80, 85, 88, 89.9]},
    'etr': {str(d): float(irradiance.get_extra_radiation(d, method='spencer')) for d in [1, 80, 172, 266, 355, 365]},
    'clearsky_tl35_alt19': rv['clearsky'],
}
json.dump(out, open(OUT, 'w'))
print('wrote', OUT)
