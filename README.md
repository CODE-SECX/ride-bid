# RideNego - Ride Fare Negotiation App

A real-time ride fare negotiation application with Supabase database and Node.js/Express backend with WebSocket support.

## Prerequisites

1. **Node.js** - v14 or higher
2. **Supabase Account** - Create a project at [supabase.com](https://supabase.com)

## Setup Instructions

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

4. Server runs at `http://localhost:3000`

### 3. Using the App

1. Open `http://localhost:3000` in your browser
2. **Passenger View**: Enter your name and phone number to create an account
3. Create a ride request with pickup, drop-off, and your offered fare
4. **Driver View**: Switch to "I'm a Driver" tab and login
   - Default driver credentials:
     - Username: `driver`
     - Password: `driver123`
5. Drivers can accept, counter, or reject ride requests
6. Real-time updates via WebSocket - no polling needed!

## Project Structure

```
ride-ngo/
├── .env                  # Environment variables
├── package.json          # Node.js dependencies
├── server/
│   └── index.js          # Express + WebSocket server
├── supabase-setup.sql    # Database schema
├── ridenegotiate.html    # Frontend (served by server)
└── README.md
```

## Features

- Real-time ride request updates via WebSocket
- Fare negotiation (accept, counter, reject)
- Passenger and driver authentication
- Auto-expiration of pending rides
- Responsive design

## API Endpoints

- `POST /api/passengers` - Create/get passenger
- `POST /api/drivers/login` - Driver login
- `POST /api/rides` - Create ride request
- `GET /api/rides` - Get all pending rides
- `PATCH /api/rides/:id` - Update ride status
- `POST /api/rides/:id/counter` - Counter offer
- `POST /api/rides/:id/accept` - Accept ride
- `POST /api/rides/:id/reject` - Reject ride

## WebSocket Events

- `ride_update` - Broadcast when any ride status changes