"""Site-constraint lookup as an HTTP service - same shape as
local-rag/service.py (FastAPI, one clear endpoint), on its own port so it
can run alongside the text-RAG service and the Next.js app.

Run it:
    source ../venv/bin/activate
    uvicorn gis_service:app --host 0.0.0.0 --port 8011

Then:
    curl -s -X POST http://localhost:8011/site-constraints \\
      -H "Content-Type: application/json" \\
      -d '{"postcode": "SW1V 3LX"}'

Port 8011 is deliberately different from local-rag's own service.py
(8010), voice-service (8008), and the Next.js app (3000).
"""

import logging
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from gis_common import GIS_DATABASE_URL
from gis_lookup import geocode_postcode, site_constraints

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("gis-service")

app = FastAPI(title="Urban AI - Site Constraints (Planning Data/PostGIS)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SiteConstraintsRequest(BaseModel):
    postcode: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    label: Optional[str] = None


@app.get("/health")
def health():
    try:
        from gis_common import get_conn

        conn = get_conn()
        conn.close()
        return {"status": "ok", "database": GIS_DATABASE_URL}
    except Exception as e:
        return {"status": "db_unreachable", "error": str(e)}


@app.post("/site-constraints")
def site_constraints_endpoint(req: SiteConstraintsRequest):
    if req.lat is not None and req.lon is not None:
        lat, lon = req.lat, req.lon
    elif req.postcode:
        geocoded = geocode_postcode(req.postcode)
        if not geocoded:
            return {"error": f"Postcode {req.postcode!r} not found."}
        lat, lon = geocoded
    else:
        return {"error": "Provide either 'postcode' or both 'lat' and 'lon'."}

    result = site_constraints(lat, lon)
    result["label"] = req.label
    logger.info(
        f"site-constraints lat={lat} lon={lon} "
        f"lpa={result['local_planning_authority']} "
        f"conservation_area_matches={len(result['conservation_areas']['matches'])}"
    )
    return result
