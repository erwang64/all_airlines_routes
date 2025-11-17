#!/usr/bin/python
import sys
import json
from collections import defaultdict
import time

from curl_cffi import requests
import lxml.html
from geopy.distance import geodesic

if __name__ == "__main__":

    print("Fetching airports list...")
    response = requests.get(
        "https://www.flightsfrom.com/airports", impersonate="chrome"
    )
    try:
        airports_json = json.loads(response.content)
    except json.decoder.JSONDecodeError as e:
        print("Failed to load airport JSON, page body was: '%s'" % response.content)
        sys.exit(1)

    iatas = [airport["IATA"] for airport in airports_json["response"]["airports"]]

    # TEST: Limitons à quelques aéroports pour tester
    iatas = iatas[:3]  # Seulement les 3 premiers pour le test
    
    airports = defaultdict(dict)

    while iatas:
        iata = iatas.pop()
        if iata in airports:
            continue

        print("Fetching #%s: %s" % (len(airports), iata))

        while True:
            try:
                response = requests.get(
                    "https://www.flightsfrom.com/%s/destinations" % iata, impersonate="chrome"
                )
                root = lxml.html.document_fromstring(response.content)
                metadata_nodes = root.xpath('//script[contains(., "window.airport")]')
                metadata_tag = metadata_nodes[0].text_content()
                metadata_bits = metadata_tag.split("window.")
                break
            except Exception as e:
                print("! Error while fetching IATA, having a little 5m sleep before retrying: %s" % e)
                time.sleep(60*5)

        metadata = {}
        for bit in metadata_bits:
            split = bit.find("=")
            if split != -1:
                metadata[bit[:split].strip()] = json.loads(bit.strip()[split + 2 : -1])

        airport_fields = [
            "city_name",
            "continent",
            "country",
            "country_code",
            "display_name",
            "elevation",
            "IATA",
            "ICAO",
            "latitude",
            "longitude",
            "name",
            "timezone",
        ]
        airport = {
            field.lower(): metadata["airport"][field] for field in airport_fields
        }
        if airport["elevation"]:
            airport["elevation"] = int(airport["elevation"])

        routes = []
        for route in metadata["routes"]:
            carrier_fields = [
                "name",
                "IATA",
            ]

            carriers = []
            for aroute in route["airlineroutes"]:
                # Vérification moins stricte - on ajoute toutes les compagnies
                try:
                    carrier_data = {
                        field.lower(): aroute["airline"].get(field, "")
                        for field in carrier_fields
                    }
                    # On ajoute la compagnie si elle a au moins un nom ou un code IATA
                    if carrier_data.get("name") or carrier_data.get("iata"):
                        carriers.append(carrier_data)
                except (KeyError, TypeError) as e:
                    # On ignore les erreurs et on continue
                    continue

            orig_ll = (airport["latitude"], airport["longitude"])
            dest_ll = (route["airport"]["latitude"], route["airport"]["longitude"])
            distance = int(geodesic(orig_ll, dest_ll).km)

            routes.append(
                {
                    "carriers": carriers,
                    "km": distance,
                    "min": int(route["common_duration"]),
                    "iata": route["iata_to"],
                }
            )

            iatas.append(route["iata_to"])

        airport["routes"] = routes
        airports[iata] = airport
        
        # Affichons un aperçu des carriers trouvés
        total_carriers = sum(len(r["carriers"]) for r in routes)
        print(f"  -> {len(routes)} routes, {total_carriers} carriers found")
        
        # Afficher les détails des premières routes avec carriers
        routes_with_carriers = [r for r in routes if r["carriers"]]
        if routes_with_carriers:
            print(f"  -> Exemple de routes avec compagnies :")
            for r in routes_with_carriers[:3]:  # Afficher max 3 exemples
                print(f"     {iata} -> {r['iata']}: {[c['name'] for c in r['carriers']]}")
        else:
            print(f"  -> AUCUNE compagnie trouvée pour cet aéroport!")

        # time.sleep(1)  # Commenté pour aller plus vite

    print("\n" + "="*60)
    print("RÉSUMÉ FINAL:")
    print("="*60)
    
    total_airports = len(airports)
    total_routes = sum(len(airport["routes"]) for airport in airports.values())
    total_carriers = sum(
        len(route["carriers"]) 
        for airport in airports.values() 
        for route in airport["routes"]
    )
    
    print(f"Aéroports traités: {total_airports}")
    print(f"Routes totales: {total_routes}")
    print(f"Compagnies totales: {total_carriers}")
    
    # Statistiques par aéroport
    print("\nDétail par aéroport:")
    for iata, airport in sorted(airports.items()):
        routes_count = len(airport["routes"])
        carriers_count = sum(len(r["carriers"]) for r in airport["routes"])
        print(f"  {iata}: {routes_count} routes, {carriers_count} compagnies")
    
    with open("airline_routes.json", "w") as f:
        f.write(json.dumps(airports, indent=4, sort_keys=True, separators=(",", ": ")))
    
    print(f"\n✓ Fichier sauvegardé: airline_routes.json")