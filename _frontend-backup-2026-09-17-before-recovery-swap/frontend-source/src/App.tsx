import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Customers } from './pages/Customers';
import { CustomerAccount } from './pages/CustomerAccount';
import { CustomerAccountsList } from './pages/CustomerAccountsList';
import { CustomerStatement } from './pages/CustomerStatement';
import { Invoices } from './pages/Invoices';
import { InvoiceDetail } from './pages/InvoiceDetail';
import { Payments } from './pages/Payments';
import { ArAging } from './pages/ArAging';
import { SalesOrdersList } from './pages/sales-orders/SalesOrdersList';
import { SalesOrdersCreate } from './pages/sales-orders/SalesOrdersCreate';
import { SalesOrdersDetail } from './pages/sales-orders/SalesOrdersDetail';
import { SalesOrdersEdit } from './pages/sales-orders/SalesOrdersEdit';
import { Products } from './pages/Products';
import { PriceLists } from './pages/PriceLists';
import { Bom } from './pages/Bom';
import { Warehouses } from './pages/Warehouses';
import { TreasuryAccounts } from './pages/TreasuryAccounts';
import { TreasuryLedger } from './pages/TreasuryLedger';
import { Inventory } from './pages/Inventory';
import { Fulfillment } from './pages/Fulfillment';
import { Shipments } from './pages/Shipments';
import { ShippingMethods } from './pages/ShippingMethods';
import { Returns } from './pages/Returns';
import { ShipmentReturns } from './pages/ShipmentReturns';
import { SalesReturns } from './pages/SalesReturns';
import { CustodyReturns } from './pages/CustodyReturns';
import { CollectionSettlements } from './pages/CollectionSettlements';
import { CustodianDetail } from './pages/CustodianDetail';
import { Admin } from './pages/Admin';
import { ReleaseCenter } from './pages/ReleaseCenter';
import { Organization } from './pages/Organization';
import { Reports } from './pages/Reports';
import { ReportsCover } from './pages/covers/ReportsCover';
import { ExternalIntegrations } from './pages/ExternalIntegrations';
import { SalesOrderPrint } from './pages/print/SalesOrderPrint';
import { WaybillPrint } from './pages/print/WaybillPrint';
import { DepositReceiptPrint } from './pages/print/DepositReceiptPrint';
import { PickListPrint } from './pages/print/PickListPrint';
import { PackListPrint } from './pages/print/PackListPrint';
import { DeliveryPrint } from './pages/print/DeliveryPrint';
import { ReturnPrint } from './pages/print/ReturnPrint';
import { InventoryMovementPrint } from './pages/print/InventoryMovementPrint';
import { CustomerPrint } from './pages/print/CustomerPrint';
import { ProductListPrint } from './pages/print/ProductListPrint';
import { PriceListPrint } from './pages/print/PriceListPrint';
import { WarehouseOverview } from './pages/warehouse/WarehouseOverview';
import { MovementCenter } from './pages/warehouse/MovementCenter';
import { WarehouseTransactionForm } from './pages/warehouse/WarehouseTransactionForm';
import { WarehouseTransactionDetail } from './pages/warehouse/WarehouseTransactionDetail';
import { StockCountStart } from './pages/warehouse/StockCountStart';
import { StockCountEntry } from './pages/warehouse/StockCountEntry';
import { WarehouseTransactionPrint } from './pages/print/WarehouseTransactionPrint';
import { ReportPrint } from './pages/print/ReportPrint';
import { CustodyStatementPrint } from './pages/print/CustodyStatementPrint';
import { InvoicePrint } from './pages/print/InvoicePrint';
import { PaymentReceiptPrint } from './pages/print/PaymentReceiptPrint';
import { CollectionReceiptPrint } from './pages/print/CollectionReceiptPrint';
import { CustomerStatementPrint } from './pages/print/CustomerStatementPrint';
import { SalesCover } from './pages/covers/SalesCover';
import { ShippingCover } from './pages/covers/ShippingCover';
import { CatalogCover } from './pages/covers/CatalogCover';
import { TreasuryCover } from './pages/covers/TreasuryCover';
import { AdminCover } from './pages/covers/AdminCover';
import { FulfillmentCover } from './pages/covers/FulfillmentCover';
import { CustomersAccountsCover } from './pages/covers/CustomersAccountsCover';
import './styles/ui.css';

function WarehouseTransactionFormRoute() {
  const { type } = useParams<{ type: 'receipt' | 'issue' | 'transfer' | 'adjustment' }>();
  return <WarehouseTransactionForm type={type ?? 'receipt'} />;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="empty-state">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="empty-state">Loading…</div>;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfAuthed>
            <Login />
          </RedirectIfAuthed>
        }
      />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        {/* CTO directive ("Section Cover / Main Dashboard System") — one landing Cover per major section, reachable from its sidebar group header. */}
        <Route path="sales" element={<SalesCover />} />
        <Route path="shipping" element={<ShippingCover />} />
        <Route path="catalog" element={<CatalogCover />} />
        <Route path="treasury" element={<TreasuryCover />} />
        <Route path="administration" element={<AdminCover />} />
        <Route path="fulfillment-overview" element={<FulfillmentCover />} />
        <Route path="customers-accounts" element={<CustomersAccountsCover />} />
        <Route path="customers" element={<Customers />} />
        <Route path="customers/:id/account" element={<CustomerAccount />} />
        <Route path="customer-accounts" element={<CustomerAccountsList />} />
        <Route path="customer-statement" element={<CustomerStatement />} />
        <Route path="invoices" element={<Invoices />} />
        <Route path="invoices/:id" element={<InvoiceDetail />} />
        <Route path="payments" element={<Payments />} />
        <Route path="ar-aging" element={<ArAging />} />
        <Route path="sales-orders" element={<SalesOrdersList />} />
        <Route path="sales-orders/new" element={<SalesOrdersCreate />} />
        <Route path="sales-orders/:id" element={<SalesOrdersDetail />} />
        <Route path="sales-orders/:id/edit" element={<SalesOrdersEdit />} />
        <Route path="products" element={<Products />} />
        <Route path="price-lists" element={<PriceLists />} />
        <Route path="bom" element={<Bom />} />
        <Route path="warehouses" element={<Warehouses />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="fulfillment" element={<Fulfillment />} />
        <Route path="shipments" element={<Shipments />} />
        <Route path="shipping-methods" element={<ShippingMethods />} />
        <Route path="returns" element={<Returns />} />
        <Route path="sales-returns" element={<SalesReturns />} />
        <Route path="shipment-returns" element={<ShipmentReturns />} />
        <Route path="custody-returns" element={<CustodyReturns />} />
        <Route path="collection-settlements" element={<CollectionSettlements />} />
        <Route path="custodian/:type/:id" element={<CustodianDetail />} />
        <Route path="admin" element={<Admin />} />
        <Route path="release-center" element={<ReleaseCenter />} />
        <Route path="organization" element={<Organization />} />
        <Route path="reports-overview" element={<ReportsCover />} />
        <Route path="reports" element={<Reports />} />
        <Route path="integrations" element={<ExternalIntegrations />} />
        <Route path="warehouse-overview" element={<WarehouseOverview />} />
        <Route path="movement-center" element={<MovementCenter />} />
        <Route path="movement-center/new/:type" element={<WarehouseTransactionFormRoute />} />
        <Route path="movement-center/:id" element={<WarehouseTransactionDetail />} />
        <Route path="stock-count" element={<StockCountStart />} />
        <Route path="stock-count/:id" element={<StockCountEntry />} />
        <Route path="treasury/accounts" element={<TreasuryAccounts />} />
        <Route path="treasury/ledger" element={<TreasuryLedger />} />
      </Route>
      {/* Print routes: auth-gated, but deliberately outside <Layout> — no sidebar/topbar chrome on a printed document. */}
      <Route path="print/sales-order/:id" element={<RequireAuth><SalesOrderPrint /></RequireAuth>} />
      <Route path="print/waybill/:id" element={<RequireAuth><WaybillPrint /></RequireAuth>} />
      <Route path="print/deposit/:id" element={<RequireAuth><DepositReceiptPrint /></RequireAuth>} />
      <Route path="print/pick/:id" element={<RequireAuth><PickListPrint /></RequireAuth>} />
      <Route path="print/pack/:id" element={<RequireAuth><PackListPrint /></RequireAuth>} />
      <Route path="print/delivery/:id" element={<RequireAuth><DeliveryPrint /></RequireAuth>} />
      <Route path="print/return/:id" element={<RequireAuth><ReturnPrint /></RequireAuth>} />
      <Route path="print/movement/:id" element={<RequireAuth><InventoryMovementPrint /></RequireAuth>} />
      <Route path="print/customer/:id" element={<RequireAuth><CustomerPrint /></RequireAuth>} />
      <Route path="print/products" element={<RequireAuth><ProductListPrint /></RequireAuth>} />
      <Route path="print/price-list/:id" element={<RequireAuth><PriceListPrint /></RequireAuth>} />
      <Route path="print/warehouse-transaction/:id" element={<RequireAuth><WarehouseTransactionPrint /></RequireAuth>} />
      <Route path="print/report" element={<RequireAuth><ReportPrint /></RequireAuth>} />
      <Route path="print/custody/:type/:id" element={<RequireAuth><CustodyStatementPrint /></RequireAuth>} />
      <Route path="print/invoice/:id" element={<RequireAuth><InvoicePrint /></RequireAuth>} />
      <Route path="print/payment/:id" element={<RequireAuth><PaymentReceiptPrint /></RequireAuth>} />
      <Route path="print/collection/:shipmentId" element={<RequireAuth><CollectionReceiptPrint /></RequireAuth>} />
      <Route path="print/customer-statement/:id" element={<RequireAuth><CustomerStatementPrint /></RequireAuth>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <LanguageProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </LanguageProvider>
    </BrowserRouter>
  );
}
