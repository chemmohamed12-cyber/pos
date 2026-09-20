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
import { Suppliers } from './pages/procurement/Suppliers';
import { PurchaseOrders } from './pages/procurement/PurchaseOrders';
import { SupplierInvoices } from './pages/procurement/SupplierInvoices';
import { ApAging } from './pages/procurement/ApAging';
import { SupplierStatement } from './pages/procurement/SupplierStatement';
import { PurchaseRequests } from './pages/procurement/PurchaseRequests';
import { Rfqs } from './pages/procurement/Rfqs';
import { TreasuryAccounts } from './pages/TreasuryAccounts';
import { TreasuryLedger } from './pages/TreasuryLedger';
import { HrEmployees } from './pages/hr/HrEmployees';
import { HrDepartments } from './pages/hr/HrDepartments';
import { HrLeaveRequests } from './pages/hr/HrLeaveRequests';
import { HrCover } from './pages/covers/HrCover';
import { WorkOrders } from './pages/manufacturing/WorkOrders';
import { WorkOrderDetail } from './pages/manufacturing/WorkOrderDetail';
import { ManufacturingCover } from './pages/covers/ManufacturingCover';
import { AttendanceConnectors } from './pages/attendance/AttendanceConnectors';
import { AttendanceImport } from './pages/attendance/AttendanceImport';
import { AttendanceBiometricImport } from './pages/attendance/AttendanceBiometricImport';
import { AttendanceFacts } from './pages/attendance/AttendanceFacts';
import { AttendanceDays } from './pages/attendance/AttendanceDays';
import { AttendanceCover } from './pages/covers/AttendanceCover';
import { PayrollPeriods } from './pages/payroll/PayrollPeriods';
import { PayrollCompensation } from './pages/payroll/PayrollCompensation';
import { PayrollRuns } from './pages/payroll/PayrollRuns';
import { PayrollRunDetail } from './pages/payroll/PayrollRunDetail';
import { PayrollCover } from './pages/covers/PayrollCover';
import { AccountingCover } from './pages/covers/AccountingCover';
import { ChartOfAccounts } from './pages/accounting/ChartOfAccounts';
import { Journals } from './pages/accounting/Journals';
import { JournalDetail } from './pages/accounting/JournalDetail';
import { GeneralLedger } from './pages/accounting/GeneralLedger';
import { TrialBalance } from './pages/accounting/TrialBalance';
import { FinancialEvents } from './pages/accounting/FinancialEvents';
import { ArReconciliation } from './pages/accounting/ArReconciliation';
import { ApReconciliation } from './pages/accounting/ApReconciliation';
import { CashBankReconciliation } from './pages/accounting/CashBankReconciliation';
import { FixedAssets } from './pages/accounting/FixedAssets';
import { InventoryAccounting } from './pages/accounting/InventoryAccounting';
import { GrniReconciliation } from './pages/accounting/GrniReconciliation';
import { FiscalPeriods } from './pages/accounting/FiscalPeriods';
import { ClosingAudit } from './pages/accounting/ClosingAudit';
import { ClosingExceptions } from './pages/accounting/ClosingExceptions';
import { ClosingSnapshots } from './pages/accounting/ClosingSnapshots';
import { Dimensions } from './pages/accounting/Dimensions';
import { AccountingSettings } from './pages/accounting/AccountingSettings';
import { BalanceSheet } from './pages/accounting/BalanceSheet';
import { ProfitAndLoss } from './pages/accounting/ProfitAndLoss';
import { CashFlowStatement } from './pages/accounting/CashFlowStatement';
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
import { Approvals } from './pages/Approvals';
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
        <Route path="suppliers" element={<Suppliers />} />
        <Route path="purchase-orders" element={<PurchaseOrders />} />
        <Route path="supplier-invoices" element={<SupplierInvoices />} />
        <Route path="ap-aging" element={<ApAging />} />
        <Route path="supplier-statement" element={<SupplierStatement />} />
        <Route path="purchase-requests" element={<PurchaseRequests />} />
        <Route path="rfqs" element={<Rfqs />} />
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
        <Route path="approvals" element={<Approvals />} />
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
        <Route path="hr" element={<HrCover />} />
        <Route path="hr/employees" element={<HrEmployees />} />
        <Route path="hr/departments" element={<HrDepartments />} />
        <Route path="hr/leave-requests" element={<HrLeaveRequests />} />
        <Route path="manufacturing" element={<ManufacturingCover />} />
        <Route path="manufacturing/work-orders" element={<WorkOrders />} />
        <Route path="manufacturing/work-orders/:id" element={<WorkOrderDetail />} />
        <Route path="attendance" element={<AttendanceCover />} />
        <Route path="attendance/connectors" element={<AttendanceConnectors />} />
        <Route path="attendance/import" element={<AttendanceImport />} />
        <Route path="attendance/biometric-import" element={<AttendanceBiometricImport />} />
        <Route path="attendance/facts" element={<AttendanceFacts />} />
        <Route path="attendance/days" element={<AttendanceDays />} />
        <Route path="payroll" element={<PayrollCover />} />
        <Route path="payroll/periods" element={<PayrollPeriods />} />
        <Route path="payroll/compensation" element={<PayrollCompensation />} />
        <Route path="payroll/runs" element={<PayrollRuns />} />
        <Route path="payroll/runs/:id" element={<PayrollRunDetail />} />
        <Route path="accounting" element={<AccountingCover />} />
        <Route path="accounting/chart-of-accounts" element={<ChartOfAccounts />} />
        <Route path="accounting/journals" element={<Journals />} />
        <Route path="accounting/journals/:id" element={<JournalDetail />} />
        <Route path="accounting/ledger" element={<GeneralLedger />} />
        <Route path="accounting/trial-balance" element={<TrialBalance />} />
        <Route path="accounting/financial-events" element={<FinancialEvents />} />
        <Route path="accounting/ar" element={<ArReconciliation />} />
        <Route path="accounting/ap" element={<ApReconciliation />} />
        <Route path="accounting/cash-bank" element={<CashBankReconciliation />} />
        <Route path="accounting/fixed-assets" element={<FixedAssets />} />
        <Route path="accounting/inventory" element={<InventoryAccounting />} />
        <Route path="accounting/grni" element={<GrniReconciliation />} />
        <Route path="accounting/fiscal-periods" element={<FiscalPeriods />} />
        <Route path="accounting/fiscal-periods/:periodId/closing-audit" element={<ClosingAudit />} />
        <Route path="accounting/fiscal-periods/:periodId/closing-exceptions" element={<ClosingExceptions />} />
        <Route path="accounting/fiscal-periods/:periodId/closing-snapshots" element={<ClosingSnapshots />} />
        <Route path="accounting/dimensions" element={<Dimensions />} />
        <Route path="accounting/settings" element={<AccountingSettings />} />
        <Route path="accounting/reports/balance-sheet" element={<BalanceSheet />} />
        <Route path="accounting/reports/profit-and-loss" element={<ProfitAndLoss />} />
        <Route path="accounting/reports/cash-flow" element={<CashFlowStatement />} />
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
