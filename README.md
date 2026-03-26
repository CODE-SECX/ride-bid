# RideNego - Ride Fare Negotiation App

A real-time ride fare negotiation application with Supabase database.

## Prerequisites

1. **Node.js** - v14 or higher
2. **Supabase Account** - Create a project at [supabase.com](https://supabase.com)

## Local Development

### 1. Database Setup

1. Go to your Supabase project
2. Open the **SQL Editor**
3. Copy and paste the contents of `supabase-setup.sql`
4. Run the SQL to create all tables, indexes, and policies
5. Get your **SUPABASE_URL** and **SUPABASE_ANON_KEY** from Project Settings → API

### 2. Backend Setup

1. Edit `.env` file and add your Supabase credentials:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your-anon-key-here
   PORT=3000
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Open `http://localhost:3000` in your browser

## Deployment to Vercel

1. Push your code to GitHub
2. Go to [Vercel](https://vercel.com) and import your repository
3. Add environment variables in Vercel project settings:
   - `SUPABASE_URL` - Your Supabase project URL
   - `SUPABASE_ANON_KEY` - Your Supabase anon key
4. Deploy

**Note**: Vercel serverless functions don't support WebSockets. For production:
- Use polling for real-time updates (already implemented in frontend)
- Or use Supabase Realtime for live updates

## Features

- Fare negotiation (accept, counter, reject)
- Passenger and driver authentication
- Auto-expiration of pending rides
- Responsive design
- Real-time updates (WebSocket locally, polling on Vercel)

## Project Structure

```
ride-ngo/
├── .env                  # Environment variables
├── package.json          # Node.js dependencies
├── server/
│   └── index.js          # Express + WebSocket server
├── api/
│   └── rides.js          # Vercel API handler
├── supabase-setup.sql    # Database schema
├── ridenegotiate.html    # Frontend
├── vercel.json           # Vercel config
└── README.md
```

## API Endpoints

- `POST /api/passengers` - Create/get passenger
- `POST /api/drivers/login` - Driver login
- `POST /api/rides` - Create ride request
- `GET /api/rides` - Get all rides
- `PATCH /api/rides/:id` - Update ride
- `POST /api/rides/:id/counter` - Counter offer
- `POST /api/rides/:id/accept` - Accept ride
- `POST /api/rides/:id/reject` - Reject ride
- `POST /api/rides/:id/complete` - Complete ride
- `POST /api/rides/:id/accept-counter` - Accept counter
- `POST /api/rides/:id/decline-counter` - Decline counter