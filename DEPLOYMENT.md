# FridgePodge API Server Deployment Guide

## Important Security Notice

The Gemini API key is now stored server-side for security. **NEVER** commit the `.env` file to version control!

## Environment Variables

When deploying to Render or any other platform, you must set these environment variables:

```
DATABASE_URL=postgresql://[your-database-url]
GEMINI_API_KEY=[your-gemini-api-key]
PORT=3000
NODE_ENV=production
CACHE_TTL=3600
INTERNAL_API_KEY=fridgepodge-2024-secure-key
```

## Render Deployment

1. Go to your Render dashboard
2. Navigate to your service (fridgepodge-api)
3. Click on "Environment" tab
4. Add the following variables:
   - `GEMINI_API_KEY` - Your Gemini API key (required)
   - `INTERNAL_API_KEY` - Optional extra security layer
   - All other variables from above

## Security Best Practices

1. **API Key Protection**:
   - Never expose the Gemini API key in client code
   - Use environment variables on the server
   - Enable rate limiting (already configured)

2. **Rate Limiting**:
   - Recipe generation: 10 requests per 15 minutes per device
   - General API: Standard rate limits apply

3. **Request Validation**:
   - All requests require a device ID
   - Ingredients must be provided
   - Server validates all inputs

## Testing the Secure Endpoint

```bash
curl -X POST https://fridgepodge-api.onrender.com/api/recipes/generate \
  -H "Content-Type: application/json" \
  -d '{
    "ingredients": ["chicken", "rice", "tomatoes"],
    "deviceId": "test-device-123",
    "theme": "italian",
    "dietaryRestrictions": [],
    "spicePacks": ["basic"]
  }'
```

## Monitoring

- Check server logs for any API key exposure
- Monitor rate limit hits
- Track API usage to stay within Gemini quotas