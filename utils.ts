

// Function to search for restaurants using Google Maps API
export async function searchGooglePlaces(params: { location: string; limit?: number; apiKey: string }): Promise<any[]> {
    const { location, limit = 20, apiKey } = params;
  
    if (!apiKey) {
      throw new Error('Missing API Key');
    }
    
    if (!location) {
      throw new Error('Location parameter is required');
    }
  
    try {
      // PASO 1: Geocoding (Location -> Coordinates)
      const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`;
      const geocodeResponse = await fetch(geocodeUrl);
      
      if (!geocodeResponse.ok) {
        throw new Error(`Geocoding API request failed: ${geocodeResponse.statusText}`);
      }
      
      const geocodeData = await geocodeResponse.json();
      
      if (geocodeData.status !== 'OK' || !geocodeData.results || geocodeData.results.length === 0) {
        throw new Error(`Could not geocode location: ${location}. Status: ${geocodeData.status}`);
      }
  
      const { lat, lng } = geocodeData.results[0].geometry.location;
  
      // PASO 2: Nearby Search (Coordinates -> Places)
      const nearbyUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&rankby=distance&type=restaurant&key=${apiKey}`;
      const nearbyResponse = await fetch(nearbyUrl);
      
      if (!nearbyResponse.ok) {
        throw new Error(`Nearby Search API request failed: ${nearbyResponse.statusText}`);
      }
      
      const nearbyData = await nearbyResponse.json();
      
      if (nearbyData.status !== 'OK' && nearbyData.status !== 'ZERO_RESULTS') {
        throw new Error(`Nearby Search failed. Status: ${nearbyData.status}`);
      }
  
      const nearbyResults = nearbyData.results || [];
  
      // Limitar resultados antes de obtener detalles
      const limitedResults = nearbyResults.slice(0, limit);
  
      // PASO 3: Place Details (Place ID -> Details)
      const detailedResults: any[] = [];
      
      for (const place of limitedResults) {
        if (!place.place_id) continue;
  
        const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_address,website,formatted_phone_number,place_id&key=${apiKey}`;
        
        try {
          const detailsResponse = await fetch(detailsUrl);
          
          if (!detailsResponse.ok) {
            continue;
          }
          
          const detailsData = await detailsResponse.json();
          
          if (detailsData.status === 'OK' && detailsData.result) {
            const result = detailsData.result;
            detailedResults.push({
              id: result.place_id,
              nombre: result.name,
              direccion: result.formatted_address,
              telefono: result.formatted_phone_number,
              web: result.website,
            });
          }
        } catch (detailsError) {
          // Skip this restaurant if there's an error
        }
      }
  
      return detailedResults;
  
    } catch (error: any) {
      throw new Error(error.message || 'Failed to process place search');
    }
  }