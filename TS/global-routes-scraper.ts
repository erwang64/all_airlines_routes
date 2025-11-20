import puppeteer, { Browser, Page } from 'puppeteer';
import * as fs from 'fs/promises';
import * as path from 'path';

interface AirportData {
  iata: string;
  name?: string;
  city_name?: string;
  country?: string;
}

interface FlightRoute {
  flightNumber: string;
  airline: string;
  airlineIATA: string;
  destination: string;
  destinationIATA: string;
  gate?: string;
  scheduledTime?: string;
}

interface AirportRoutes {
  iata: string;
  airportName?: string;
  city?: string;
  country?: string;
  totalFlights: number;
  routes: FlightRoute[];
  scrapedAt: string;
  error?: string;
}

interface GlobalRoutesData {
  generatedAt: string;
  totalAirports: number;
  successfulAirports: number;
  failedAirports: number;
  airports: AirportRoutes[];
}

class GlobalRoutesScraper {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private results: GlobalRoutesData;
  private processedCount = 0;
  private failedCount = 0;

  constructor() {
    this.results = {
      generatedAt: new Date().toISOString(),
      totalAirports: 0,
      successfulAirports: 0,
      failedAirports: 0,
      airports: []
    };
  }

  /**
   * Charge la liste des aéroports depuis airline_routes.json
   */
  async loadAirports(): Promise<AirportData[]> {
    console.log('📂 Chargement de la liste des aéroports...');
    
    const jsonPath = path.join(process.cwd(), 'airline_routes.json');
    const content = await fs.readFile(jsonPath, 'utf-8');
    const data = JSON.parse(content);

    const airports: AirportData[] = [];
    
    for (const [iata, airportInfo] of Object.entries(data)) {
      if (iata && iata.length === 3) {
        airports.push({
          iata,
          name: (airportInfo as any).name,
          city_name: (airportInfo as any).city_name,
          country: (airportInfo as any).country
        });
      }
    }

    console.log(`✅ ${airports.length} aéroports chargés`);
    return airports;
  }

  /**
   * Initialise le navigateur et accepte les cookies une fois
   */
  async initBrowser(): Promise<void> {
    console.log('🚀 Initialisation du navigateur...');
    
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080'
      ]
    });

    this.page = await this.browser.newPage();
    
    // Masquer les traces de Puppeteer/automation
    await this.page.evaluateOnNewDocument(() => {
      // Supprimer les propriétés qui indiquent l'automatisation
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
      
      // Ajouter des propriétés manquantes
      (window.navigator as any).chrome = {
        runtime: {},
      };
      
      // Modifier les permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters: any) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: 'denied' } as PermissionStatus) :
          originalQuery(parameters)
      );
    });
    
    await this.page.setViewport({ width: 1920, height: 1080 });
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    
    // Ajouter des headers supplémentaires
    await this.page.setExtraHTTPHeaders({
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });

    // Accepter les cookies UNE SEULE FOIS au début
    console.log('🍪 Acceptation des cookies...');
    await this.page.goto('https://planefinder.net', { waitUntil: 'networkidle0' });
    await new Promise(resolve => setTimeout(resolve, 3000));
    await this.acceptCookies();
    console.log('✅ Cookies acceptés pour toute la session');
  }

  /**
   * Clique sur "Show earlier flights" jusqu'à ce qu'il n'y en ait plus
   */
  async loadAllFlights(): Promise<void> {
    if (!this.page) return;

    let clickCount = 0;
    const maxClicks = 50; // Sécurité pour éviter une boucle infinie
    let noNewFlightsCount = 0; // Compteur de clics sans nouveaux vols

    while (clickCount < maxClicks) {
      try {
        // Compter le nombre de vols AVANT le clic
        const flightCountBefore = await this.page.evaluate(() => {
          return document.querySelectorAll('table tbody tr').length;
        });

        // Attendre un peu pour laisser le temps au contenu de charger
        await new Promise(resolve => setTimeout(resolve, 500));

        // Chercher et cliquer sur le bouton
        const buttonClicked = await this.page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, a'));
          const targetBtn = buttons.find(btn => {
            const text = btn.textContent?.toLowerCase() || '';
            return text.includes('show earlier') || 
                   text.includes('load more') ||
                   text.includes('earlier flights');
          }) as HTMLElement;
          
          if (targetBtn && !targetBtn.hasAttribute('disabled')) {
            targetBtn.click();
            return true;
          }
          return false;
        });

        if (!buttonClicked) {
          console.log(`   ✓ Tous les vols chargés (${clickCount} clics)`);
          break;
        }

        clickCount++;
        console.log(`   ↻ Chargement de vols supplémentaires (${clickCount})...`);
        
        // Attendre que les nouveaux vols se chargent
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Compter le nombre de vols APRÈS le clic
        const flightCountAfter = await this.page.evaluate(() => {
          return document.querySelectorAll('table tbody tr').length;
        });

        // Vérifier si de nouveaux vols sont apparus
        if (flightCountAfter <= flightCountBefore) {
          noNewFlightsCount++;
          console.log(`   ⚠ Aucun nouveau vol (${noNewFlightsCount}/3)`);
          
          // Si 3 clics consécutifs sans nouveaux vols, on arrête
          if (noNewFlightsCount >= 3) {
            console.log(`   ✓ Tous les vols chargés (${clickCount} clics, ${flightCountAfter} vols au total)`);
            break;
          }
        } else {
          // Réinitialiser le compteur si de nouveaux vols sont apparus
          noNewFlightsCount = 0;
          const newFlights = flightCountAfter - flightCountBefore;
          console.log(`   ✅ +${newFlights} nouveaux vols (total: ${flightCountAfter})`);
        }

      } catch (error) {
        console.log(`   ⚠ Fin du chargement (${clickCount} clics)`);
        break;
      }
    }

    if (clickCount >= maxClicks) {
      console.log(`   ⚠ Limite de ${maxClicks} clics atteinte`);
    }
  }

  /**
   * Accepte les cookies si la popup apparaît
   */
  async acceptCookies(): Promise<void> {
    if (!this.page) return;

    try {
      // Attendre que la popup de cookies se charge
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Chercher et cliquer sur le bouton d'acceptation des cookies
      const result = await this.page.evaluate(() => {
        // Debug: compter les boutons
        const allButtons = document.querySelectorAll('button');
        
        // Méthode 1: Chercher par classe spécifique
        const buttonByClass = document.querySelector('.sp_choice_type_11') as HTMLElement;
        if (buttonByClass) {
          buttonByClass.click();
          return { success: true, method: 'class', buttons: allButtons.length };
        }

        // Méthode 2: Chercher dans le div #notice
        const noticeDiv = document.querySelector('#notice');
        if (noticeDiv) {
          const buttons = noticeDiv.querySelectorAll('button');
          for (const btn of buttons) {
            const text = btn.textContent || '';
            if (text.includes('Accepter et fermer') || text.includes('Accept and close')) {
              (btn as HTMLElement).click();
              return { success: true, method: 'notice', buttons: allButtons.length };
            }
          }
        }

        // Méthode 3: Chercher par texte dans tous les boutons
        for (const btn of allButtons) {
          const text = btn.textContent || '';
          if (text.includes('Accepter et fermer') || text.includes('Accept and close')) {
            (btn as HTMLElement).click();
            return { success: true, method: 'text', buttons: allButtons.length };
          }
        }

        return { success: false, method: 'none', buttons: allButtons.length };
      });

      if (result.success) {
        console.log(`   🍪 Cookies acceptés (méthode: ${result.method})`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      // Si erreur, on continue quand même
    }
  }

  /**
   * Extrait les routes d'un aéroport
   */
  async scrapeAirport(airport: AirportData): Promise<AirportRoutes> {
    if (!this.page) {
      throw new Error('Le navigateur n\'est pas initialisé');
    }

    const url = `https://planefinder.net/data/airport/${airport.iata}/departures`;
    console.log(`\n📍 [${this.processedCount + 1}/${this.results.totalAirports}] ${airport.iata} - ${airport.city_name || airport.name}`);

    try {
      // Navigation vers la page
      await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });

      // Attendre que le tableau se remplisse avec les données dynamiques
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Vérifier si des vols sont chargés
      const initialFlightCount = await this.page.evaluate(() => {
        return document.querySelectorAll('table tbody tr').length;
      });
      
      if (initialFlightCount === 0) {
        console.log(`   ℹ️  Aucun vol programmé`);
      }

      // Prendre une capture d'écran pour debug (seulement premier aéroport)
      if (this.processedCount === 0) {
        await this.page.screenshot({ 
          path: `debug_airport_${airport.iata}.png` as `${string}.png`,
          fullPage: true 
        });
        console.log(`   📸 Capture d'écran de debug sauvegardée`);
      }

      // Charger tous les vols en cliquant sur "Show earlier flights"
      await this.loadAllFlights();

      // Extraire les données
      const routes = await this.page.evaluate(() => {
        const flightData: FlightRoute[] = [];
        
        const rows = document.querySelectorAll('table tbody tr');
        
        if (rows.length === 0) {
          return flightData;
        }

        rows.forEach((row) => {
          try {
            const cells = row.querySelectorAll('td');
            if (cells.length < 6) return;

            // Table structure: Scheduled | Flight | Departing to | Airline | Terminal | Gate | Status
            const scheduledTime = cells[0]?.textContent?.trim() || '';
            const flightNumber = cells[1]?.textContent?.trim() || '';
            const departingTo = cells[2]?.textContent?.trim() || ''; // e.g., "Copenhagen CPH"
            const airlineCell = cells[3]?.textContent?.trim() || ''; // e.g., "KLM Royal Dutch Airlines\n            KLM"
            const gate = cells[5]?.textContent?.trim() || '';

            // Extract time (HH:MM)
            const timeMatch = scheduledTime.match(/(\d{2}:\d{2})/);
            const time = timeMatch ? timeMatch[1] : '';

            // Extract flight number (e.g., "SK1260")
            const flightMatch = flightNumber.match(/([A-Z0-9]{2,3}\d{3,4})/);
            const flight = flightMatch ? flightMatch[1] : '';
            
            // Parse airline cell: "KLM Royal Dutch Airlines\n            KLM" -> name: "KLM Royal Dutch Airlines", IATA: "KLM"
            let airlineName = '';
            let airlineIATA = '';
            
            if (airlineCell) {
              // Split by newlines and clean whitespace
              const parts = airlineCell.split('\n').map(p => p.trim()).filter(p => p.length > 0);
              if (parts.length >= 2) {
                // First part is the full name, second part is the IATA code
                airlineName = parts[0];
                airlineIATA = parts[1];
              } else if (parts.length === 1) {
                // Only one part, could be either name or IATA
                const part = parts[0];
                // Check if it looks like an IATA code (2-3 uppercase letters)
                if (part.match(/^[A-Z0-9]{2,3}$/)) {
                  airlineIATA = part;
                  airlineName = part; // Fallback to IATA as name
                } else {
                  airlineName = part;
                }
              }
            }

            // Parse destination: "Copenhagen CPH" -> name: "Copenhagen", IATA: "CPH"
            let destinationName = '';
            let destinationIATA = '';
            
            if (departingTo) {
              // Look for IATA code (3 capital letters) at the end
              const destMatch = departingTo.match(/^(.+?)\s+([A-Z]{3})$/);
              if (destMatch) {
                destinationName = destMatch[1].trim();
                destinationIATA = destMatch[2];
              } else {
                // If no IATA code found, try to extract just the IATA
                const iataMatch = departingTo.match(/\b([A-Z]{3})\b/);
                if (iataMatch) {
                  destinationIATA = iataMatch[1];
                  destinationName = departingTo.replace(iataMatch[1], '').trim();
                } else {
                  destinationName = departingTo;
                }
              }
            }

            if (flight && destinationIATA && airlineName) {
              flightData.push({
                flightNumber: flight,
                airline: airlineName,
                airlineIATA: airlineIATA || '',
                destination: destinationName,
                destinationIATA: destinationIATA,
                gate: gate,
                scheduledTime: time
              });
            }
          } catch (error) {
            // Ignorer les erreurs de parsing individuelles
          }
        });

        return flightData;
      });

      this.processedCount++;
      this.results.successfulAirports++;

      console.log(`   ✅ ${routes.length} routes extraites`);

      return {
        iata: airport.iata,
        airportName: airport.name,
        city: airport.city_name,
        country: airport.country,
        totalFlights: routes.length,
        routes,
        scrapedAt: new Date().toISOString()
      };

    } catch (error) {
      this.failedCount++;
      this.results.failedAirports++;
      
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`   ❌ Erreur: ${errorMsg}`);

      return {
        iata: airport.iata,
        airportName: airport.name,
        city: airport.city_name,
        country: airport.country,
        totalFlights: 0,
        routes: [],
        scrapedAt: new Date().toISOString(),
        error: errorMsg
      };
    }
  }

  /**
   * Sauvegarde les résultats intermédiaires
   */
  async saveProgress(): Promise<void> {
    const filename = 'global_routes_progress.json';
    await fs.writeFile(filename, JSON.stringify(this.results, null, 2), 'utf-8');
    console.log(`\n💾 Progression sauvegardée: ${filename}`);
  }

  /**
   * Sauvegarde les résultats finaux
   */
  async saveFinalResults(): Promise<void> {
    const filename = 'global_routes_final.json';
    await fs.writeFile(filename, JSON.stringify(this.results, null, 2), 'utf-8');
    console.log(`\n💾 Résultats finaux sauvegardés: ${filename}`);
  }

  /**
   * Ferme le navigateur
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      console.log('🔒 Navigateur fermé');
    }
  }

  /**
   * Charge la progression existante si elle existe
   */
  async loadProgress(): Promise<void> {
    const filename = 'global_routes_progress.json';
    try {
      const content = await fs.readFile(filename, 'utf-8');
      const savedData = JSON.parse(content);
      
      this.results = savedData;
      this.processedCount = savedData.airports.length;
      
      console.log(`📂 Progression existante trouvée: ${this.processedCount} aéroports déjà traités`);
      console.log(`   Succès: ${savedData.successfulAirports} | Échecs: ${savedData.failedAirports}`);
    } catch (error) {
      console.log('📂 Aucune progression existante, démarrage depuis le début');
    }
  }

  /**
   * Processus principal
   */
  async run(): Promise<void> {
    try {
      // Charger les aéroports
      const airports = await this.loadAirports();
      
      // Charger la progression existante
      await this.loadProgress();
      
      this.results.totalAirports = airports.length;

      console.log(`\n🌍 Scraping de ${airports.length} aéroports du monde entier`);
      console.log('⏱️  Cela peut prendre plusieurs heures...\n');
      console.log('='.repeat(60));

      // Initialiser le navigateur
      await this.initBrowser();

      // Traiter chaque aéroport (reprendre là où on s'est arrêté)
      const startIndex = this.processedCount;
      console.log(`\n🚀 Démarrage du scraping à partir de l'aéroport #${startIndex + 1}\n`);
      
      for (let i = startIndex; i < airports.length; i++) {
        const airport = airports[i];
        const airportResult = await this.scrapeAirport(airport);
        this.results.airports.push(airportResult);

        // Sauvegarder la progression tous les 10 aéroports
        if ((i + 1) % 10 === 0) {
          await this.saveProgress();
          
          // Afficher les statistiques
          const successRate = ((this.results.successfulAirports / (i + 1)) * 100).toFixed(1);
          console.log(`\n📊 Statistiques: ${i + 1}/${airports.length} | Succès: ${this.results.successfulAirports} (${successRate}%) | Échecs: ${this.results.failedAirports}`);
        }

        // Pause entre chaque aéroport pour éviter d'être bloqué
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Sauvegarder les résultats finaux
      await this.saveFinalResults();

      // Afficher le résumé
      console.log('\n' + '='.repeat(60));
      console.log('✅ SCRAPING TERMINÉ !');
      console.log('='.repeat(60));
      console.log(`Total aéroports traités: ${this.results.totalAirports}`);
      console.log(`Succès: ${this.results.successfulAirports}`);
      console.log(`Échecs: ${this.results.failedAirports}`);
      console.log(`Total routes extraites: ${this.results.airports.reduce((sum, a) => sum + a.totalFlights, 0)}`);

    } catch (error) {
      console.error('\n❌ Erreur fatale:', error);
      await this.saveProgress();
    } finally {
      await this.close();
    }
  }
}

/**
 * Fonction principale
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        SCRAPER GLOBAL DES ROUTES AÉRIENNES MONDIALES      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log();

  const scraper = new GlobalRoutesScraper();
  await scraper.run();
}

// Exécuter le script
if (require.main === module) {
  main().catch(console.error);
}

export { GlobalRoutesScraper };
