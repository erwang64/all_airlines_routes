const { connect } = require("puppeteer-real-browser");
const fs = require("fs");

// ==========================================
// CONFIGURATION
// ==========================================
const BASE_URL = "https://www.airnavradar.com/data/airlines";
const DELAY_MIN = 1500; // Délai minimum entre actions (ms)
const DELAY_MAX = 3500; // Délai maximum entre actions (ms)
const MAX_LOAD_ATTEMPTS = 50; // Nombre max de clics par bouton

// ==========================================
// UTILITAIRES
// ==========================================
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
    return Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN + 1)) + DELAY_MIN;
}

function log(message) {
    const timestamp = new Date().toISOString().slice(11, 19);
    console.log(`[${timestamp}] ${message}`);
}

// ==========================================
// SCRAPER PRINCIPAL
// ==========================================
async function scrapeAirline(airlineCode, options = {}) {
    const maxClicks = options.maxClicks || MAX_LOAD_ATTEMPTS;
    const headless = options.headless ?? false; // Mode visible par défaut (plus fiable)

    log(`🚀 Démarrage du scraper pour: ${airlineCode}`);
    log(`   Mode: ${headless ? "headless" : "visible"}`);
    log(`   Max clics: ${maxClicks}`);

    let browser, page;

    try {
        // Lancement du navigateur avec anti-détection
        log("📱 Lancement du navigateur...");
        const response = await connect({
            headless: headless,
            turnstile: true, // Gère automatiquement les challenges Cloudflare Turnstile
            fingerprint: true, // Fingerprint aléatoire
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--window-size=1920,1080",
            ],
        });

        browser = response.browser;
        page = response.page;

        // Navigation vers la page
        const url = `${BASE_URL}/${airlineCode}`;
        log(`🌐 Navigation vers: ${url}`);

        await page.goto(url, {
            waitUntil: "networkidle2",
            timeout: 60000,
        });

        // Attendre que la page charge (Cloudflare peut prendre du temps)
        log("⏳ Attente du chargement de la page...");
        await sleep(5000);

        // Vérifier si on est bloqué par Cloudflare
        const pageContent = await page.content();
        if (
            pageContent.includes("Just a moment") ||
            pageContent.includes("Checking your browser")
        ) {
            log("🔄 Challenge Cloudflare détecté, attente...");
            await sleep(10000);
        }

        // Gérer les popups de cookies/consent
        log("🍪 Fermeture des popups...");
        try {
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll("button, a, div, span"));
                const closeKeywords = ["accept", "agree", "close", "ok", "got it", "dismiss", "✕", "×"];

                for (const btn of buttons) {
                    const text = btn.textContent?.toLowerCase() || "";
                    const ariaLabel = btn.getAttribute("aria-label")?.toLowerCase() || "";

                    if (closeKeywords.some(kw => text.includes(kw) || ariaLabel.includes(kw))) {
                        if (btn.offsetParent !== null) {
                            btn.click();
                            break;
                        }
                    }
                }
            });
            await sleep(1000);
        } catch (e) {
            // Pas de popup
        }

        // Fonction pour cliquer sur un bouton de chargement
        async function clickLoadButton(buttonText) {
            let clickCount = 0;
            let previousFlightCount = 0;
            let stableCount = 0;

            while (clickCount < maxClicks) {
                try {
                    // Compter les vols actuels
                    const currentFlightCount = await page.evaluate(() => {
                        const rows = document.querySelectorAll("table tbody tr");
                        return rows ? rows.length : 0;
                    });

                    // Chercher et cliquer sur le bouton
                    const clicked = await page.evaluate((text) => {
                        const elements = Array.from(document.querySelectorAll("button, a, span"));
                        for (const el of elements) {
                            if (
                                el.textContent?.toLowerCase().includes(text.toLowerCase()) &&
                                el.offsetParent !== null
                            ) {
                                el.click();
                                return true;
                            }
                        }
                        return false;
                    }, buttonText);

                    if (!clicked) {
                        log(`✅ Bouton "${buttonText}" non trouvé - fin du chargement`);
                        break;
                    }

                    clickCount++;
                    log(`🔄 Clic ${clickCount} sur "${buttonText}" - ${currentFlightCount} vols`);

                    // Attendre le chargement
                    await sleep(randomDelay());

                    // Vérifier si de nouveaux vols ont été chargés
                    if (currentFlightCount === previousFlightCount) {
                        stableCount++;
                        if (stableCount >= 2) {
                            log(`✅ Plus de nouveaux vols pour "${buttonText}" après ${clickCount} clics`);
                            break;
                        }
                    } else {
                        stableCount = 0;
                    }

                    previousFlightCount = currentFlightCount;
                } catch (err) {
                    log(`⚠️ Erreur lors du clic sur "${buttonText}": ${err.message}`);
                    break;
                }
            }
        }

        // Charger tous les vols précédents
        log("⬅️ Chargement des vols précédents (Load Earlier)...");
        await clickLoadButton("earlier");

        // Charger tous les vols suivants
        log("➡️ Chargement des vols suivants (Load Later)...");
        await clickLoadButton("later");

        // Extraction des données de vols
        log("📊 Extraction des données de vols...");

        const flights = await page.evaluate(() => {
            const results = [];

            const table = document.querySelector("table");
            if (!table) return results;

            // Récupérer les en-têtes
            const headers = [];
            const headerCells = table.querySelectorAll("thead th, thead td");
            headerCells.forEach((cell) => {
                headers.push(cell.textContent.trim().toLowerCase().replace(/\s+/g, "_"));
            });

            // Si pas d'en-têtes dans thead, essayer la première ligne
            if (headers.length === 0) {
                const firstRow = table.querySelector("tr");
                if (firstRow) {
                    firstRow.querySelectorAll("th, td").forEach((cell) => {
                        headers.push(cell.textContent.trim().toLowerCase().replace(/\s+/g, "_"));
                    });
                }
            }

            // Récupérer les lignes de données
            const rows = table.querySelectorAll("tbody tr");
            rows.forEach((row) => {
                const flight = {};
                const cells = row.querySelectorAll("td");

                cells.forEach((cell, index) => {
                    const key = headers[index] || `col_${index}`;
                    flight[key] = cell.textContent.trim();

                    // Récupérer aussi les liens si présents
                    const link = cell.querySelector("a");
                    if (link && link.href) {
                        flight[`${key}_link`] = link.href;
                    }
                });

                if (Object.keys(flight).length > 0) {
                    results.push(flight);
                }
            });

            return results;
        });

        log(`📦 ${flights.length} vols extraits`);

        // Sauvegarder en JSON
        const filename = `flights_${airlineCode}.json`;
        const output = {
            airline: airlineCode,
            scraped_at: new Date().toISOString(),
            total_flights: flights.length,
            flights: flights,
        };

        fs.writeFileSync(filename, JSON.stringify(output, null, 2), "utf8");
        log(`💾 Données sauvegardées dans: ${filename}`);

        // Afficher un aperçu
        if (flights.length > 0) {
            log("📋 Aperçu des premiers vols:");
            flights.slice(0, 3).forEach((f, i) => {
                console.log(`   ${i + 1}. ${JSON.stringify(f).substring(0, 100)}...`);
            });
        }

        return { success: true, filename, count: flights.length, flights };
    } catch (error) {
        log(`❌ Erreur: ${error.message}`);
        return { success: false, error: error.message };
    } finally {
        if (browser) {
            log("🔒 Fermeture du navigateur...");
            await browser.close();
        }
    }
}

// ==========================================
// POINT D'ENTRÉE CLI
// ==========================================
const args = process.argv.slice(2);
const airlineCode = args[0];
const maxClicks = args.find(a => a.startsWith("--max="))?.split("=")[1];
const headless = args.includes("--headless");

if (!airlineCode) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║           AIRNAVRADAR SCRAPER - Globalink Cargo              ║
╠══════════════════════════════════════════════════════════════╣
║  Usage: node scraper.js <CODE_ICAO> [options]                ║
║                                                              ║
║  Arguments:                                                  ║
║    CODE_ICAO    Code ICAO de la compagnie (ex: UPS, FDX)    ║
║                                                              ║
║  Options:                                                    ║
║    --headless   Mode sans interface (déconseillé)           ║
║    --max=N      Nombre max de clics (défaut: 100)           ║
║                                                              ║
║  Exemples:                                                   ║
║    node scraper.js UPS                                       ║
║    node scraper.js FDX --max=50                              ║
║    node scraper.js DHL --headless                            ║
║                                                              ║
║  Compagnies cargo courantes:                                 ║
║    UPS (UPS Airlines), FDX (FedEx), DHL, BOX (ABX Air)       ║
║    GTI (Atlas Air), CLX (Cargolux), SQC (Singapore Cargo)    ║
╚══════════════════════════════════════════════════════════════╝
  `);
    process.exit(1);
}

scrapeAirline(airlineCode.toUpperCase(), {
    maxClicks: maxClicks ? parseInt(maxClicks) : MAX_LOAD_ATTEMPTS,
    headless: headless,
})
    .then((result) => {
        if (result.success) {
            console.log(`\n✅ Scraping terminé! ${result.count} vols dans ${result.filename}`);
            console.log(`\n📤 Importe ce fichier sur: /admin/scraping/airnav`);
        } else {
            console.log(`\n❌ Échec du scraping: ${result.error}`);
            process.exit(1);
        }
    })
    .catch((err) => {
        console.error("Erreur fatale:", err);
        process.exit(1);
    });

// Export pour utilisation en module
module.exports = { scrapeAirline };
